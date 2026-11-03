#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { relative } from 'node:path';
import { startRecording } from './recorder/recorder.js';
import { DataGenerator, CATALOG } from './data/faker.js';
import {
  dateBoundaries, edgeCases, lengthBoundaries, lengthPartitions, numberBoundaries, numberPartitions,
  type TestValue,
} from './data/boundaries.js';
import { techniqueName } from './data/techniques.js';
import type { TimelineEvent } from './recorder/types.js';

const HELP = `qa-recorder: a recording browser for QA

Usage:
  qa-recorder record [url] [options]
  qa-recorder data <command> [options]     Generate test data in the terminal

Record options:
  -o, --out <dir>        Folder for recordings (default: ./recordings)
  --slow <ms>            Flag API calls slower than this (default: 1000)
  --no-screenshots       Don't take a screenshot after each action
  --keep-secrets         Record password and card values instead of masking them
  --no-warnings          Only log console errors, not warnings
  --include-documents    Also log page loads, not just XHR and fetch calls
  --headless             Run without a window (for CI)
  --executable <path>    Use this Chromium or Chrome binary
  --no-panel             Hide the in-page test data panel (Alt+Shift+D)
  --profiles <file>      Data profiles file (default: .qa-recorder/profiles.json)
  --seed <n>             Faker seed, to reproduce generated data
  -h, --help             Show this help

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
      if (!event.isError && !event.isSlow) {
        return `${time} ${dim(`${event.method} ${event.status ?? ''} ${event.durationMs ?? '?'}ms ${event.url}`)}`;
      }
      const tag = event.isError ? red('API ERR ') : yellow('API SLOW');
      const status = event.failure ?? `${event.status} ${event.statusText ?? ''}`.trim();
      return `${time} ${tag} ${event.method} ${event.url} → ${status} in ${event.durationMs ?? '?'}ms`;
    }
    case 'console':
      return `${time} ${event.level === 'error' ? red('CONSOLE ') : yellow('WARNING ')} ${event.text}`;
    case 'pageerror':
      return `${time} ${red('JS ERROR')} ${event.message}`;
    case 'navigation':
      return `${time} ${dim(`${event.newPage ? 'new tab' : 'navigate'} ${event.url}`)}`;
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
      seed: { type: 'string' },
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
    ...(values.seed !== undefined && { seed: Number(values.seed) }),
    onEvent: (event) => {
      const line = format(event);
      if (line) console.log(line);
    },
  });

  console.log(`Test data panel: press Alt+Shift+D in the page, or click "Test data" (seed ${recorder.data.generator.seed}).`);
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

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '-h' || command === '--help') {
    console.log(HELP);
    return;
  }
  if (command === 'record') return record(rest);
  if (command === 'data') return data(rest);
  // Allow `qa-recorder https://example.com` as a shortcut.
  if (/^(https?:|[\w-]+\.)/.test(command)) return record([command, ...rest]);
  console.error(`Unknown command "${command}".\n\n${HELP}`);
  process.exitCode = 1;
}

main().catch((error: Error) => {
  console.error(red(error.message));
  process.exitCode = 1;
});
