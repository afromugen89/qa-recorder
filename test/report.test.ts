import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRecording, type Recorder } from '../src/index.js';
import type { SessionData } from '../src/index.js';
import { describeAction, endpointKey, apiPerformance, buildBugReport } from '../src/report/bug.js';
import { jiraCopy } from '../src/report/jira.js';
import type { WrittenReport } from '../src/report/render.js';
import { startDemo, type DemoServer } from './fixtures/server.js';

let demo: DemoServer;
let outDir: string;
let recorder: Recorder;
let first: WrittenReport;
let second: WrittenReport;
let session: SessionData;
let secondCreated: { jira: { summary: string; wiki: string; html: string }; attachments: string[]; attachmentsDir: string };

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
  // The panel no longer suggests a title; the QA types it.
  assert.equal(draft.result.title, undefined);
  assert.equal(draft.result.hasPreviousBug, true);
  const created = await page.evaluate(() =>
    (window as any).__qaPanel({ cmd: 'createBug', bug: { scope: 'since-last-bug', techniques: ['error-guessing'], severity: 'critical' } }),
  );
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.match(created.result.title, /Boom from demo/);
  const bugDirs = readdirSync(join(recorder.sessionDir, 'bugs')).sort();
  const secondDir = join(recorder.sessionDir, 'bugs', bugDirs[1]);
  second = {
    dir: secondDir,
    html: join(secondDir, 'report.html'),
    markdown: join(secondDir, 'report.md'),
    json: join(secondDir, 'bug.json'),
    report: JSON.parse(readFileSync(join(secondDir, 'bug.json'), 'utf8')),
  } as WrittenReport;
  secondCreated = created.result;
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
  assert.equal((first.report as any).actual, undefined);
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
  for (const heading of ['## Steps to reproduce', '## Expected result', '## Test design technique (ISTQB)', '## Failed API calls', '## API response times']) {
    assert.ok(md.includes(heading), heading);
  }
  assert.ok(!md.includes('Actual result'));
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

test('API sections can be left out, and single calls or endpoints dropped', () => {
  const toSeq = session.events.find((e) => e.type === 'bug')!.seq;
  const full = buildBugReport(session, { toSeq });
  assert.equal(full.failedApiCalls.length, 1);
  assert.equal(full.slowApiCalls.length, 1);
  assert.ok(full.apiPerformance.length >= 3);
  assert.ok(full.failedApiCalls.every((c) => /^\d+$/.test(c.key)));

  const none = buildBugReport(session, { toSeq, sections: { failedApiCalls: false, slowApiCalls: false, apiResponseTimes: false } });
  assert.deepEqual([none.failedApiCalls.length, none.slowApiCalls.length, none.apiPerformance.length], [0, 0, 0]);
  const { wiki, html } = jiraCopy(none);
  for (const heading of ['Failed API calls', 'Slow API calls', 'API response times']) {
    assert.ok(!wiki.includes(heading), heading);
    assert.ok(!html.includes(heading), heading);
  }

  const dropEndpoint = full.apiPerformance[0].endpoint;
  const some = buildBugReport(session, { toSeq, excludeApiCalls: [full.slowApiCalls[0].key], excludeEndpoints: [dropEndpoint] });
  assert.equal(some.failedApiCalls.length, 1);
  assert.equal(some.slowApiCalls.length, 0);
  assert.equal(some.apiPerformance.length, full.apiPerformance.length - 1);
  assert.ok(!some.apiPerformance.some((p) => p.endpoint === dropEndpoint));
});

test('the panel draft lists API calls and endpoints for picking', async () => {
  // Built the same way the panel's bugDraft command builds it.
  const { bugDraft } = await import('../src/report/bug.js');
  const d = bugDraft({ ...session, events: session.events.filter((e) => e.seq < session.events.find((x) => x.type === 'bug')!.seq) });
  assert.equal(d.apiLists.failedApiCalls.length, 1);
  assert.match(d.apiLists.failedApiCalls[0].label, /GET \/api\/fail → 500/);
  assert.equal(d.apiLists.slowApiCalls.length, 1);
  assert.ok(d.apiLists.apiResponseTimes.some((e) => e.key.endsWith('/api/slow')));
});

test('reports have no timeline, test data seed or recording time', () => {
  const html = readFileSync(first.html, 'utf8');
  const md = readFileSync(first.markdown, 'utf8');
  const json = JSON.parse(readFileSync(first.json, 'utf8'));
  for (const text of [html, md, first.jira.wiki]) {
    assert.ok(!/Full timeline|Test data seed|Recorded/.test(text), 'removed fields are gone');
  }
  assert.equal(json.timeline, undefined);
  assert.equal(json.environment.dataSeed, undefined);
  assert.equal(json.environment.recordedAt, undefined);
});

test('writes Jira text, attachments and a copy button', () => {
  const wiki = readFileSync(first.jiraFile, 'utf8');
  assert.match(wiki, /^\*Severity:\* major/);
  assert.match(wiki, /\*Test technique \(ISTQB\):\* Boundary value analysis/);
  for (const heading of ['Environment', 'Steps to reproduce', 'Expected result', 'Test design technique (ISTQB)', 'Failed API calls', 'Screenshots']) {
    assert.match(wiki, new RegExp(`^h3\\. ${heading.replace(/[()]/g, '\\$&')}$`, 'm'), heading);
  }
  assert.doesNotMatch(wiki, /Actual result/);
  assert.match(wiki, /^# Open http/m);
  assert.match(wiki, /^\|\|Step\|\|Request\|\|Status\|\|Time\|\|$/m);
  assert.match(wiki, /\{noformat\}\n.*Database timeout/s);
  assert.match(wiki, /^!bug-screenshot\.png\|thumbnail!$/m);
  // Every screenshot named in the text is in the attachments folder.
  const files = readdirSync(first.attachmentsDir);
  for (const a of first.jira.attachments) {
    assert.ok(files.includes(a.name), a.name);
    assert.ok(wiki.includes(`!${a.name}|thumbnail!`), a.name);
  }
  assert.ok(first.jira.attachments.some((a) => /^step-\d{2}\.png$/.test(a.name)));
  assert.match(first.jira.html, /<h3>Steps to reproduce<\/h3>\s*<ol><li>/);

  const html = readFileSync(first.html, 'utf8');
  assert.match(html, /id="copy-jira"/);
  assert.match(html, /<template id="jira-html"><p><strong>Severity:<\/strong>/);
  assert.ok(html.includes('&#39;') || !html.includes("'</textarea>"));

  // The panel gets the same text back to copy.
  assert.equal(secondCreated.jira.summary, second.report.title);
  assert.match(secondCreated.jira.wiki, /h3\. Steps to reproduce/);
});

test('Jira text escapes markup characters but keeps URLs', () => {
  const r = buildBugReport(session, { toSeq: session.events.find((e) => e.type === 'bug')!.seq, title: 't', notes: 'Use {code} and [link] | pipe *bold* at https://x.test/a_b?c=[1]' });
  const { wiki } = jiraCopy(r);
  assert.ok(wiki.includes('Use \\{code\\} and \\[link\\] \\| pipe \\*bold\\* at https://x.test/a_b?c=[1]'), wiki.split('h3. Notes')[1]);
});

test('screenshots in the HTML report open at full size', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.goto(`file://${first.html}`);
    const shot = page.locator('figure img.zoom').first();
    const shown = await shot.evaluate((img: HTMLImageElement) => ({ shown: img.clientWidth, natural: img.naturalWidth }));
    assert.ok(shown.shown < shown.natural, 'thumbnail is scaled down');
    assert.equal(await page.locator('#lightbox').isVisible(), false);
    await shot.click();
    const big = page.locator('#lightbox img');
    await big.waitFor();
    const size = await big.evaluate((img: HTMLImageElement) => ({ shown: img.clientWidth, natural: img.naturalWidth }));
    assert.equal(size.shown, size.natural, 'opens at original size');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#lightbox').isVisible(), false);

    // The copy button puts wiki markup and rich text on the clipboard.
    const copied = await page.evaluate(() => {
      const got: Record<string, string> = {};
      document.addEventListener('copy', (e) => {
        setTimeout(() => {
          got.text = e.clipboardData!.getData('text/plain');
          got.html = e.clipboardData!.getData('text/html');
        });
      });
      const realSet = DataTransfer.prototype.setData;
      DataTransfer.prototype.setData = function (type: string, value: string) { got[type] = value; return realSet.call(this, type, value); };
      (document.getElementById('copy-jira') as HTMLButtonElement).click();
      return { plain: got['text/plain'], html: got['text/html'], status: document.getElementById('copy-status')!.textContent };
    });
    assert.match(copied.plain, /h3\. Steps to reproduce/);
    assert.match(copied.html, /<h3>Steps to reproduce<\/h3>/);
  } finally {
    await browser.close();
  }
});
