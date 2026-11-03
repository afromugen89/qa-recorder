#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { relative } from 'node:path';
import { startRecording } from './recorder/recorder.js';
import type { TimelineEvent } from './recorder/types.js';

const HELP = `qa-recorder: a recording browser for QA

Usage:
  qa-recorder record [url] [options]

Options:
  -o, --out <dir>        Folder for recordings (default: ./recordings)
  --slow <ms>            Flag API calls slower than this (default: 1000)
  --no-screenshots       Don't take a screenshot after each action
  --keep-secrets         Record password and card values instead of masking them
  --no-warnings          Only log console errors, not warnings
  --include-documents    Also log page loads, not just XHR and fetch calls
  --headless             Run without a window (for CI)
  --executable <path>    Use this Chromium or Chrome binary
  -h, --help             Show this help

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
      return `${time} ${green(event.action.padEnd(8))} ${event.locator.code}${detail}${frame}`;
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
    onEvent: (event) => {
      const line = format(event);
      if (line) console.log(line);
    },
  });

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

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '-h' || command === '--help') {
    console.log(HELP);
    return;
  }
  if (command === 'record') return record(rest);
  // Allow `qa-recorder https://example.com` as a shortcut.
  if (/^(https?:|[\w-]+\.)/.test(command)) return record([command, ...rest]);
  console.error(`Unknown command "${command}".\n\n${HELP}`);
  process.exitCode = 1;
}

main().catch((error: Error) => {
  console.error(red(error.message));
  process.exitCode = 1;
});
