#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { relative } from 'node:path';
import { startRecording } from './recorder/recorder.js';
import { DataGenerator, CATALOG } from './data/faker.js';
import {
  dateBoundaries, edgeCases, lengthBoundaries, lengthPartitions, numberBoundaries, numberPartitions,
  type TestValue,
} from './data/boundaries.js';
import { ISTQB_TECHNIQUES, techniqueName, type TechniqueId } from './data/techniques.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildBugReport, type ApiSection } from './report/bug.js';
import { writeBugReport } from './report/render.js';
import { devices } from 'playwright';
import { a11ySummary, type WcagLevel, type WcagVersion } from './audit/a11y.js';
import { DEFAULT_PRESETS, VIEWPORT_PRESETS, layoutSummary } from './audit/layout.js';
import type { SessionData } from './recorder/types.js';
import type { TimelineEvent } from './recorder/types.js';

const HELP = `qa-recorder: a recording browser for QA

Usage:
  qa-recorder record [url] [options]
  qa-recorder data <command> [options]     Generate test data in the terminal
  qa-recorder report <session-folder> [options]   Write a bug report from a recording
  qa-recorder check <url> [options]        Accessibility and responsive checks, no window
  qa-recorder devices                      List device names for --device

Record options:
  -o, --out <dir>        Folder for recordings (default: ./recordings)
  --slow <ms>            Flag API calls slower than this (default: 1000)
  --no-screenshots       Don't take a screenshot after each action
  --keep-secrets         Record password and card values instead of masking them
  --no-warnings          Only log console errors, not warnings
  --include-documents    Also log page loads, not just XHR and fetch calls
  --headless             Run without a window (for CI)
  --executable <path>    Use this Chromium or Chrome binary
  --no-panel             Don't open the QA tools window (Alt+Shift+D)
  --profiles <file>      Data profiles file (default: .qa-recorder/profiles.json)
  --mocks <file>         API mock rules file (default: .qa-recorder/mocks.json)
  --seed <n>             Faker seed, to reproduce generated data
  --device <name>        Record as a phone or tablet, e.g. "iPhone 15 Pro"
  -h, --help             Show this help

Check options:
  --wcag 2.0|2.1|2.2     WCAG version (default: 2.2)
  --level A|AA|AAA       WCAG level (default: AA)
  --best-practices       Also run axe-core best-practice rules
  --sizes <ids>          Comma-separated viewports (default: ${DEFAULT_PRESETS.join(', ')})
  --widths <px,px>       Extra widths to check
  --breakpoints          Also check both sides of each CSS breakpoint
  --no-a11y  --no-layout  -o, --out <dir>  --device <name>
  Exits with code 1 when an accessibility violation or layout error is found.

Report options:
  --title <text>  --expected <text>  --notes <text>
  --severity critical|major|minor|trivial  --priority high|medium|low
  --technique bva,ep,dt,st,eg,exploratory,checklist,use-case,random
  --reporter <name>  --from-seq <n>  --to-seq <n>
  --skip-steps <n,n>        Leave these step numbers out (remaining steps are renumbered)
  --skip-screenshots <p,p>  Leave these screenshots out, e.g. screenshots/0004-click.png
  --leave-out <sections>    Leave out API sections: failed-calls, slow-calls, response-times

Data commands:
  data types                               List Faker data types
  data fake <type> [-n 5] [--locale de] [--min 1 --max 9] [--length 8]
           [--pattern REGEX] [--template "Item {i}"] [--path vehicle.vin]
  data bva --min 1 --max 99 [--step 0.01] [--three] [--partitions]
  data length --max 50 [--min 2] [--charset text|digits|email] [--three] [--partitions]
  data date --min 2026-01-01 --max 2026-12-31 [--three]
  data edge                                Error-guessing inputs

Close the browser window or press Ctrl+C to stop. The session is saved as
session.json, network.har and screenshots/ in a timestamped folder.`;

const color = (code: number) => (text: string) =>
  process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
const red = color(31);
const yellow = color(33);
const dim = color(2);
const green = color(32);

function format(event: TimelineEvent): string | undefined {
  const time = dim(`${(event.elapsedMs / 1000).toFixed(1).padStart(6)}s`);
  switch (event.type) {
    case 'action': {
      const detail =
        event.value !== undefined ? ` = ${JSON.stringify(event.value)}` :
        event.labels ? ` = ${JSON.stringify(event.labels)}` :
        event.key ? ` ${event.key}` : '';
      const frame = event.element.inShadowDom ? dim(' (shadow DOM)') : '';
      const data = event.testData
        ? dim(` [${event.testData.technique ? techniqueName(event.testData.technique) : event.testData.source}: ${event.testData.label}]`)
        : '';
      const loop = event.loop ? dim(` (loop ${event.loop.iteration})`) : '';
      return `${time} ${green(event.action.padEnd(8))} ${event.locator.code}${detail}${frame}${data}${loop}`;
    }
    case 'network': {
      const mocked = event.mock ? ` ${color(33)(`[mocked: ${event.mock.rule}]`)}` : '';
      if (!event.isError && !event.isSlow) {
        return `${time} ${dim(`${event.method} ${event.status ?? ''} ${event.durationMs ?? '?'}ms ${event.url}`)}${mocked}`;
      }
      const tag = event.isError ? red('API ERR ') : yellow('API SLOW');
      const status = event.failure ?? `${event.status} ${event.statusText ?? ''}`.trim();
      return `${time} ${tag} ${event.method} ${event.url} → ${status} in ${event.durationMs ?? '?'}ms${mocked}`;
    }
    case 'console':
      return `${time} ${event.level === 'error' ? red('CONSOLE ') : yellow('WARNING ')} ${event.text}`;
    case 'pageerror':
      return `${time} ${red('JS ERROR')} ${event.message}`;
    case 'navigation':
      return `${time} ${dim(`${event.newPage ? 'new tab' : 'navigate'} ${event.url}`)}`;
    case 'bug':
      return `${time} ${color(35)('BUG     ')} ${event.title} → ${event.reportDir}/report.html`;
    case 'a11y':
      return `${time} ${color(35)('A11Y    ')} ${event.result.standard}: ${a11ySummary(event.result)}`;
    case 'layout':
      return `${time} ${color(35)('LAYOUT  ')} ${layoutSummary(event.result)}`;
    case 'viewport':
      return `${time} ${dim(`resize ${event.width}x${event.height}${event.label ? ` ${event.label}` : ''}${event.reset ? ' (restored)' : ''}`)}`;
    case 'loop':
      return `${time} ${color(36)('LOOP    ')} ${event.phase}${event.iteration ? ` ${event.iteration}/${event.total}` : ''}${event.error ? ` ${red(event.error)}` : ''}`;
  }
}

async function record(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o', default: 'recordings' },
      slow: { type: 'string', default: '1000' },
      'no-screenshots': { type: 'boolean', default: false },
      'keep-secrets': { type: 'boolean', default: false },
      'no-warnings': { type: 'boolean', default: false },
      'include-documents': { type: 'boolean', default: false },
      headless: { type: 'boolean', default: false },
      executable: { type: 'string' },
      'no-panel': { type: 'boolean', default: false },
      profiles: { type: 'string' },
      mocks: { type: 'string' },
      seed: { type: 'string' },
      device: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }

  let url = positionals[0];
  if (url && !/^[a-z]+:/i.test(url)) url = `https://${url}`;
  const slow = Number(values.slow);
  if (!Number.isFinite(slow) || slow <= 0) throw new Error(`--slow must be a positive number of ms, got "${values.slow}"`);

  const recorder = await startRecording({
    url,
    outDir: values.out,
    slowThresholdMs: slow,
    screenshots: !values['no-screenshots'],
    keepSecrets: values['keep-secrets'],
    captureWarnings: !values['no-warnings'],
    apiResourceTypes: values['include-documents'] ? ['xhr', 'fetch', 'document'] : ['xhr', 'fetch'],
    headless: values.headless,
    executablePath: values.executable,
    panel: !values['no-panel'],
    ...(values.profiles && { profilesPath: values.profiles }),
    ...(values.mocks && { mocksPath: values.mocks }),
    ...(values.seed !== undefined && { seed: Number(values.seed) }),
    ...(values.device && { device: values.device }),
    onEvent: (event) => {
      const line = format(event);
      if (line) console.log(line);
    },
  });

  if (recorder.toolsPage) console.log(`QA tools are in their own window. Alt+Shift+D switches between them and the app (seed ${recorder.data.generator.seed}).`);
  const activeMocks = recorder.mocks.activeCount();
  if (activeMocks) console.log(color(33)(`${activeMocks} API mock${activeMocks > 1 ? 's are' : ' is'} on (from ${relative(process.cwd(), recorder.mocks.state().path)}).`));
  console.log(`Recording. Close the browser or press Ctrl+C to stop.\nSaving to ${relative(process.cwd(), recorder.sessionDir) || '.'}\n`);

  let stopping = false;
  const finish = async () => {
    if (stopping) return;
    stopping = true;
    const data = await recorder.stop();
    const s = data.summary;
    console.log(`\nSaved ${relative(process.cwd(), recorder.sessionDir)}/session.json`);
    console.log(
      `${s.actions} actions, ${s.apiCalls} API calls (${s.failedApiCalls} failed, ${s.slowApiCalls} slow` +
        `${s.avgApiDurationMs !== undefined ? `, avg ${s.avgApiDurationMs}ms` : ''}), ` +
        `${s.consoleErrors} console errors, ${s.pageErrors} uncaught JS errors`,
    );
    const bugs = data.events.filter((e) => e.type === 'bug').length;
    if (bugs) console.log(`${bugs} bug report${bugs > 1 ? 's' : ''} in ${relative(process.cwd(), recorder.sessionDir)}/bugs/`);
    else if (s.failedApiCalls || s.consoleErrors || s.pageErrors) {
      console.log(`To write a bug report: qa-recorder report ${relative(process.cwd(), recorder.sessionDir)}`);
    }
  };
  process.once('SIGINT', () => void finish().then(() => process.exit(0)));
  await recorder.waitForClose();
  await finish();
}

function printCases(cases: TestValue[]): void {
  for (const c of cases) {
    const expected = c.expected === 'valid' ? green('valid  ') : red('invalid');
    const shown = c.value.length > 60 ? `${c.value.slice(0, 60)}… (${c.value.length} chars)` : c.value;
    console.log(`${expected}  ${c.label.padEnd(28)} ${JSON.stringify(shown)}  ${dim(techniqueName(c.technique))}`);
  }
}

function data(argv: string[]): void {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      n: { type: 'string', short: 'n', default: '5' },
      locale: { type: 'string', default: 'en_US' },
      min: { type: 'string' },
      max: { type: 'string' },
      step: { type: 'string' },
      length: { type: 'string' },
      precision: { type: 'string' },
      pattern: { type: 'string' },
      template: { type: 'string' },
      path: { type: 'string' },
      args: { type: 'string' },
      charset: { type: 'string', default: 'text' },
      seed: { type: 'string' },
      three: { type: 'boolean', default: false },
      partitions: { type: 'boolean', default: false },
    },
  });
  const need = (name: 'min' | 'max') => {
    if (values[name] === undefined) throw new Error(`--${name} is required`);
    return values[name]!;
  };
  const mode = values.three ? '3-value' : '2-value';
  switch (sub) {
    case 'types': {
      let group = '';
      for (const entry of CATALOG) {
        if (entry.group !== group) console.log(`\n${(group = entry.group)}`);
        console.log(`  ${entry.id.padEnd(14)} ${entry.label}${entry.options?.length ? dim(`  (${entry.options.join(', ')})`) : ''}`);
      }
      return;
    }
    case 'fake': {
      const type = positionals[0];
      if (!type) throw new Error('Name a type, e.g. qa-recorder data fake email. See: qa-recorder data types');
      const n = (key: string) => (values[key as keyof typeof values] !== undefined ? Number(values[key as keyof typeof values]) : undefined);
      const gen = new DataGenerator(values.seed !== undefined ? Number(values.seed) : undefined);
      const spec = {
        type,
        locale: values.locale,
        options: {
          min: n('min'), max: n('max'), length: n('length'), precision: n('precision'),
          pattern: values.pattern, template: values.template, path: values.path, args: values.args,
        },
      };
      for (const v of gen.generateMany(spec, Number(values.n))) console.log(v);
      return;
    }
    case 'bva': {
      const range = { min: Number(need('min')), max: Number(need('max')), step: values.step ? Number(values.step) : 1, mode } as const;
      printCases([...numberBoundaries(range), ...(values.partitions ? numberPartitions(range) : [])]);
      return;
    }
    case 'length': {
      const range = {
        minLength: values.min ? Number(values.min) : 0,
        maxLength: Number(need('max')),
        mode,
        charset: values.charset as 'text' | 'digits' | 'email',
      } as const;
      printCases([...lengthBoundaries(range), ...(values.partitions ? lengthPartitions(range) : [])]);
      return;
    }
    case 'date':
      printCases(dateBoundaries({ min: need('min'), max: need('max'), mode }));
      return;
    case 'edge':
      printCases(edgeCases());
      return;
    default:
      throw new Error(`Unknown data command "${sub ?? ''}". Try: types, fake, bva, length, date, edge`);
  }
}

const TECHNIQUE_ALIASES: Record<string, TechniqueId> = {
  bva: 'boundary-value-analysis',
  ep: 'equivalence-partitioning',
  dt: 'decision-table-testing',
  st: 'state-transition-testing',
  eg: 'error-guessing',
  exploratory: 'exploratory-testing',
  checklist: 'checklist-based-testing',
  'use-case': 'use-case-testing',
  random: 'random-testing',
};

function report(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      title: { type: 'string' },
      expected: { type: 'string' },
      notes: { type: 'string' },
      severity: { type: 'string' },
      priority: { type: 'string' },
      technique: { type: 'string' },
      reporter: { type: 'string' },
      'from-seq': { type: 'string' },
      'to-seq': { type: 'string' },
      'skip-steps': { type: 'string' },
      'skip-screenshots': { type: 'string' },
      'leave-out': { type: 'string' },
    },
  });
  const dir = positionals[0];
  if (!dir) throw new Error('Give the session folder, e.g. qa-recorder report recordings/2026-11-03_14-05-12');
  const file = join(dir, 'session.json');
  if (!existsSync(file)) throw new Error(`No session.json in ${dir}`);
  const session = JSON.parse(readFileSync(file, 'utf8')) as SessionData;
  const techniques = values.technique?.split(',').map((t) => {
    const id = (TECHNIQUE_ALIASES[t.trim()] ?? t.trim()) as TechniqueId;
    if (!(id in ISTQB_TECHNIQUES)) throw new Error(`Unknown technique "${t}". Use: ${Object.keys(TECHNIQUE_ALIASES).join(', ')}`);
    return id;
  });
  const severities = ['critical', 'major', 'minor', 'trivial'];
  const priorities = ['high', 'medium', 'low'];
  if (values.severity && !severities.includes(values.severity)) throw new Error(`--severity must be one of ${severities.join(', ')}`);
  if (values.priority && !priorities.includes(values.priority)) throw new Error(`--priority must be one of ${priorities.join(', ')}`);
  const fromSeq = values['from-seq'] ? Number(values['from-seq']) : undefined;
  const toSeq = values['to-seq'] ? Number(values['to-seq']) : undefined;
  // Step numbers as they appear in the full report; turned into stable keys.
  const allSteps = buildBugReport(session, { fromSeq, toSeq }).steps;
  const excludeSteps = values['skip-steps']?.split(',').map((t) => {
    const step = allSteps.find((s) => s.number === Number(t.trim()));
    if (!step) throw new Error(`--skip-steps: there is no step ${t.trim()} (the report has ${allSteps.length})`);
    return step.key;
  });
  const excludeScreenshots = values['skip-screenshots']?.split(',').map((t) => t.trim().replace(/\\/g, '/'));
  const SECTION_FLAGS: Record<string, ApiSection> = {
    'failed-calls': 'failedApiCalls', 'slow-calls': 'slowApiCalls', 'response-times': 'apiResponseTimes',
  };
  const sections: Partial<Record<ApiSection, boolean>> = {};
  for (const t of values['leave-out']?.split(',') ?? []) {
    const id = SECTION_FLAGS[t.trim()];
    if (!id) throw new Error(`--leave-out: unknown section "${t.trim()}". Use: ${Object.keys(SECTION_FLAGS).join(', ')}`);
    sections[id] = false;
  }
  const written = writeBugReport(dir, session, {
    title: values.title,
    expected: values.expected,
    notes: values.notes,
    severity: values.severity as never,
    priority: values.priority as never,
    techniques,
    reporter: values.reporter,
    fromSeq,
    toSeq,
    excludeSteps,
    excludeScreenshots,
    sections,
  });
  const r = written.report;
  console.log(`${green('Bug report:')} ${r.title}`);
  console.log(`  ${r.steps.length} steps, ${r.failedApiCalls.length} failed API calls, ${r.slowApiCalls.length} slow, ` +
    `${r.consoleErrors.length} console messages, ${r.pageErrors.length} JS errors`);
  console.log(`  Technique: ${r.techniques.map((t) => t.name).join(', ')}`);
  console.log(`  ${relative(process.cwd(), written.html)}`);
  console.log(`  ${relative(process.cwd(), written.jiraFile)}  (Jira description; the HTML report has a copy button)`);
  if (written.jira.attachments.length) console.log(`  ${relative(process.cwd(), written.attachmentsDir)}  (screenshots to attach in Jira)`);
  console.log(`  ${relative(process.cwd(), written.markdown)}`);
}

function listDevices(): void {
  console.log('Presets in the Responsive tab and for check --sizes:');
  for (const p of VIEWPORT_PRESETS) console.log(`  ${p.id.padEnd(22)} ${String(p.width).padStart(4)}×${p.height}  ${dim(p.group)}`);
  console.log('\nAll Playwright devices for --device:');
  for (const name of Object.keys(devices).filter((n) => !n.endsWith('landscape'))) {
    const d = devices[name];
    console.log(`  ${name.padEnd(30)} ${String(d.viewport.width).padStart(4)}×${d.viewport.height}${d.isMobile ? dim('  mobile') : ''}`);
  }
}

/** Opens a URL without a window, runs the checks and writes a report. */
async function check(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o', default: 'recordings' },
      wcag: { type: 'string', default: '2.2' },
      level: { type: 'string', default: 'AA' },
      'best-practices': { type: 'boolean', default: false },
      sizes: { type: 'string' },
      widths: { type: 'string' },
      breakpoints: { type: 'boolean', default: false },
      'no-a11y': { type: 'boolean', default: false },
      'no-layout': { type: 'boolean', default: false },
      device: { type: 'string' },
      executable: { type: 'string' },
    },
  });
  let url = positionals[0];
  if (!url) throw new Error('Give a URL, e.g. qa-recorder check https://example.com');
  if (!/^[a-z]+:/i.test(url)) url = `https://${url}`;
  if (!['2.0', '2.1', '2.2'].includes(values.wcag!)) throw new Error('--wcag must be 2.0, 2.1 or 2.2');
  const level = values.level!.toUpperCase();
  if (!['A', 'AA', 'AAA'].includes(level)) throw new Error('--level must be A, AA or AAA');

  const recorder = await startRecording({
    url, outDir: values.out, headless: true, panel: false, executablePath: values.executable,
    ...(values.device && { device: values.device }),
  });
  let failed = false;
  try {
    await recorder.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    if (!values['no-a11y']) {
      const { result } = await recorder.audit.a11y(recorder.page, {
        version: values.wcag as WcagVersion, level: level as WcagLevel, bestPractices: values['best-practices'],
      });
      console.log(`${result.violations.length ? red('A11Y') : green('A11Y')}    ${result.standard}: ${a11ySummary(result)}`);
      for (const v of result.violations) {
        console.log(`  ${(v.impact ?? '').padEnd(9)} ${v.help} ${dim(`(${v.id}${v.wcag.length ? `, WCAG ${v.wcag.join(', ')}` : ''}) ×${v.nodeCount}`)}`);
      }
      if (result.violations.length) failed = true;
    }
    if (!values['no-layout']) {
      let boundaries: { width: number; reason: string }[] = [];
      if (values.breakpoints) {
        const found = await recorder.audit.handle(recorder.page, { cmd: 'breakpoints' }) as { ok: boolean; result?: { boundaries: typeof boundaries } };
        boundaries = found.result?.boundaries ?? [];
      }
      const { result } = await recorder.audit.layout(recorder.page, {
        presets: values.sizes ? values.sizes.split(',').map((s) => s.trim()) : DEFAULT_PRESETS,
        widths: values.widths ? values.widths.split(',').map(Number) : [],
        boundaries,
        current: false,
      });
      const errors = result.viewports.some((v) => v.error || v.issues.some((i) => i.severity === 'error'));
      console.log(`${errors ? red('LAYOUT') : green('LAYOUT')}  ${layoutSummary(result)}`);
      for (const v of result.viewports) {
        const e = v.issues.filter((i) => i.severity === 'error').length;
        console.log(`  ${`${v.width}×${v.height}`.padEnd(10)} ${v.label.padEnd(28)} ${v.error ? red(v.error) : `${e ? red(`${e} error${e > 1 ? 's' : ''}`) : '0 errors'}, ${v.issues.length - e} warning${v.issues.length - e === 1 ? '' : 's'}`}`);
      }
      if (errors) failed = true;
    }
    const written = await recorder.createBug({ title: undefined });
    console.log(`\nReport: ${relative(process.cwd(), written.html)}`);
  } finally {
    await recorder.stop();
  }
  if (failed) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '-h' || command === '--help') {
    console.log(HELP);
    return;
  }
  if (command === 'record') return record(rest);
  if (command === 'data') return data(rest);
  if (command === 'report') return report(rest);
  if (command === 'check') return check(rest);
  if (command === 'devices') return listDevices();
  // Allow `qa-recorder https://example.com` as a shortcut.
  if (/^(https?:|[\w-]+\.)/.test(command)) return record([command, ...rest]);
  console.error(`Unknown command "${command}".\n\n${HELP}`);
  process.exitCode = 1;
}

main().catch((error: Error) => {
  console.error(red(error.message));
  process.exitCode = 1;
});
