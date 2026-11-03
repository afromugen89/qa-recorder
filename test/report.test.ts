import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRecording, type Recorder } from '../src/index.js';
import type { SessionData } from '../src/index.js';
import { describeAction, endpointKey, apiPerformance } from '../src/report/bug.js';
import type { WrittenReport } from '../src/report/render.js';
import { startDemo, type DemoServer } from './fixtures/server.js';

let demo: DemoServer;
let outDir: string;
let recorder: Recorder;
let first: WrittenReport;
let second: WrittenReport;
let session: SessionData;

before(async () => {
  demo = await startDemo();
  outDir = mkdtempSync(join(tmpdir(), 'qa-recorder-report-'));
  recorder = await startRecording({ url: demo.url, outDir, headless: true, profilesPath: join(outDir, 'p.json') });
  const page = recorder.page;
  await page.waitForLoadState('load');

  // A boundary value entered through the panel, so a technique is detected.
  await page.getByLabel('Email').click();
  await page.waitForTimeout(300);
  const result = await page.evaluate(() =>
    (window as any).__qaPanel({
      cmd: 'fillValue',
      value: { value: 'a'.repeat(51), label: 'max + 1 (51 chars)', kind: 'boundary', technique: 'boundary-value-analysis', expected: 'invalid' },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  await page.getByTestId('save-btn').click();
  await page.getByRole('button', { name: 'Load orders' }).click();
  await page.getByRole('button', { name: 'Slow report' }).click();
  await page.waitForTimeout(1_500);
  first = await recorder.createBug({ expected: 'Orders load', severity: 'major', priority: 'high' });

  // Second bug, scoped to what happened after the first one, created from the panel.
  await page.getByRole('button', { name: 'Crash' }).click();
  await page.waitForTimeout(300);
  const draft = await page.evaluate(() => (window as any).__qaPanel({ cmd: 'bugDraft', scope: 'since-last-bug' }));
  assert.equal(draft.ok, true);
  assert.match(draft.result.title, /Boom from demo/);
  assert.equal(draft.result.hasPreviousBug, true);
  const created = await page.evaluate(() =>
    (window as any).__qaPanel({ cmd: 'createBug', bug: { scope: 'since-last-bug', techniques: ['error-guessing'], severity: 'critical' } }),
  );
  assert.equal(created.ok, true, JSON.stringify(created));
  const bugDirs = readdirSync(join(recorder.sessionDir, 'bugs')).sort();
  const secondDir = join(recorder.sessionDir, 'bugs', bugDirs[1]);
  second = {
    dir: secondDir,
    html: join(secondDir, 'report.html'),
    markdown: join(secondDir, 'report.md'),
    json: join(secondDir, 'bug.json'),
    report: JSON.parse(readFileSync(join(secondDir, 'bug.json'), 'utf8')),
  };
  session = await recorder.stop();
});

after(async () => {
  await demo?.close();
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

test('writes HTML, Markdown and JSON per bug', () => {
  for (const r of [first, second]) {
    assert.ok(existsSync(r.html));
    assert.ok(existsSync(r.markdown));
    assert.ok(existsSync(r.json));
  }
  assert.match(first.dir, /bugs[\\/]01-get-api-fail-returns-500/);
  assert.match(second.dir, /bugs[\\/]02-/);
});

test('suggests a title from the most serious failure and its step', () => {
  assert.equal(first.report.title, 'GET /api/fail returns 500 after clicking "Load orders" button');
});

test('lists steps in plain English with the test data technique', () => {
  const steps = first.report.steps.map((s) => s.text);
  assert.match(steps[0], /^Open http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.match(steps[1], /^Enter "a{51}" \(51 characters\) in the "Email" field$/);
  assert.equal(steps[2], 'Click the "Save" button');
  assert.equal(first.report.steps[1].technique, 'boundary-value-analysis');
  assert.equal(first.report.steps[1].expected, 'invalid');
  assert.match(first.report.steps[1].detail ?? '', /Boundary value analysis: max \+ 1/);
});

test('detects the ISTQB technique, or uses the one the tester chose', () => {
  assert.deepEqual(first.report.techniques.map((t) => t.id), ['boundary-value-analysis']);
  assert.equal(first.report.techniques[0].detected, true);
  assert.deepEqual(second.report.techniques.map((t) => t.id), ['error-guessing']);
  assert.equal(second.report.techniques[0].detected, false);
});

test('links failed API calls and console errors to the step that caused them', () => {
  const fail = first.report.failedApiCalls[0];
  assert.equal(fail.status, 500);
  const step = first.report.steps.find((s) => s.number === fail.step);
  assert.equal(step?.text, 'Click the "Load orders" button');
  assert.match(fail.responseBody ?? '', /Database timeout/);
  const consoleError = first.report.consoleErrors.find((e) => e.text === 'Order failed to load');
  assert.equal(consoleError?.step, fail.step);
  assert.match(first.report.actual, /GET \/api\/fail returned 500/);
});

test('reports slow calls and API response times per endpoint', () => {
  assert.equal(first.report.slowApiCalls.length, 1);
  const slow = first.report.apiPerformance.find((p) => p.endpoint.endsWith('/api/slow'));
  assert.ok(slow && slow.maxMs >= 1_000);
  const failing = first.report.apiPerformance[0];
  assert.equal(failing.errors, 1, 'endpoints with errors are listed first');
});

test('a report scoped after the previous bug starts where the tester was', () => {
  assert.match(second.report.steps[0].text, /^Start on http/);
  assert.equal(second.report.steps[1].text, 'Click the "Crash" button');
  assert.equal(second.report.failedApiCalls.length, 0);
  assert.equal(second.report.pageErrors[0].message, 'Boom from demo');
  assert.equal(second.report.severity, 'critical');
});

test('Markdown is ready for Jira and HTML is self-contained', () => {
  const md = readFileSync(first.markdown, 'utf8');
  for (const heading of ['## Steps to reproduce', '## Expected result', '## Actual result', '## Test design technique (ISTQB)', '## Failed API calls', '## API response times']) {
    assert.ok(md.includes(heading), heading);
  }
  assert.match(md, /\*\*Test technique \(ISTQB\):\*\* Boundary value analysis/);
  assert.match(md, /!\[Bug\]\(\.\.\/\.\.\/screenshots\/bug-\d+\.png\)/);
  const html = readFileSync(first.html, 'utf8');
  assert.match(html, /<img alt="When the bug was reported" src="data:image\/png;base64,/);
  assert.ok(!html.includes('<script>alert'), 'values are escaped');
});

test('bug events are added to the session timeline', () => {
  const bugs = session.events.filter((e) => e.type === 'bug');
  assert.equal(bugs.length, 2);
});

test('report command writes a report from a saved session', () => {
  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'report', recorder.sessionDir, '--technique', 'eg,bva', '--severity', 'minor', '--title', 'From the CLI'],
    { encoding: 'utf8' },
  );
  assert.match(out, /Bug report: From the CLI/);
  assert.match(out, /Technique: Error guessing, Boundary value analysis/);
  const dirs = readdirSync(join(recorder.sessionDir, 'bugs'));
  assert.ok(dirs.some((d) => d.startsWith('03-from-the-cli')));
});

test('describes actions and groups endpoints', () => {
  const base = { seq: 1, timestamp: 0, elapsedMs: 0, pageId: 1, type: 'action' as const, framePath: [], url: '', locator: { strategy: 'role' as const, selector: '', code: '' } };
  const el = { tag: 'select', role: 'combobox', accessibleName: 'Country', inShadowDom: false, inClosedShadowDom: false };
  assert.equal(describeAction({ ...base, action: 'select', element: el, labels: ['Singapore'] }), 'Choose "Singapore" in the "Country" dropdown');
  assert.equal(endpointKey('GET', 'https://x.test/api/orders/12345?x=1'), 'GET x.test/api/orders/:id');
  const stats = apiPerformance([
    { ...base, type: 'network', method: 'GET', url: 'https://x.test/a/1', resourceType: 'fetch', durationMs: 100, isError: false, isSlow: false },
    { ...base, type: 'network', method: 'GET', url: 'https://x.test/a/2', resourceType: 'fetch', durationMs: 300, isError: true, isSlow: false },
  ] as never);
  assert.deepEqual(stats[0], { endpoint: 'GET x.test/a/:id', calls: 2, errors: 1, avgMs: 200, p95Ms: 300, maxMs: 300 });
});
