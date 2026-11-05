import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRecording, type Recorder } from '../src/index.js';
import { buildBugReport, type BugReport } from '../src/report/bug.js';
import type { SessionData } from '../src/index.js';
import { startDemo, type DemoServer } from './fixtures/server.js';

// Picking which reproduction steps and screenshots go into a bug report.

let demo: DemoServer;
let outDir: string;
let recorder: Recorder;
let session: SessionData;
let draft: {
  stepList: { key: string; number: number; text: string; screenshot?: string }[];
  screenshots: { path: string; label: string; step?: string }[];
};
let picked: BugReport;
let pickedDir: string;

const panel = (cmd: string, args: Record<string, unknown> = {}) =>
  recorder.page.evaluate(([c, a]) => (window as any).__qaPanel({ cmd: c, ...a }), [cmd, args] as const);

before(async () => {
  demo = await startDemo();
  outDir = mkdtempSync(join(tmpdir(), 'qa-recorder-select-'));
  recorder = await startRecording({ url: demo.url, outDir, headless: true, profilesPath: join(outDir, 'p.json') });
  const page = recorder.page;
  await page.waitForLoadState('load');
  // Pause after each click so every step gets its own screenshot.
  await page.getByLabel('Accept terms').check();
  await page.waitForTimeout(900);
  await page.getByTestId('save-btn').click();
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: 'Load orders' }).click();
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: 'Slow report' }).click();
  await page.waitForTimeout(1_500);

  const d = await panel('bugDraft', { scope: 'session' });
  assert.equal(d.ok, true, JSON.stringify(d));
  draft = d.result;

  // Leave out "Tick Accept terms" and "Click Save", and one screenshot.
  const terms = draft.stepList.find((s) => /Accept terms/.test(s.text))!;
  const save = draft.stepList.find((s) => /"Save"/.test(s.text))!;
  const slowShot = draft.stepList.find((s) => /Slow report/.test(s.text))!.screenshot!;
  const created = await panel('createBug', {
    bug: { excludeSteps: [terms.key, save.key], excludeScreenshots: [slowShot], pageScreenshot: false, title: 'Picked steps' },
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  pickedDir = created.result.dir;
  picked = JSON.parse(readFileSync(join(pickedDir, 'bug.json'), 'utf8'));
  session = await recorder.stop();
});

after(async () => {
  await demo?.close();
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

test('the draft lists every step and screenshot for the pickers', () => {
  assert.deepEqual(draft.stepList.map((s) => s.number), draft.stepList.map((_, i) => i + 1));
  assert.ok(draft.stepList.every((s) => s.key));
  assert.ok(draft.stepList.some((s) => /Load orders/.test(s.text)));
  const stepShots = draft.screenshots.filter((s) => s.step);
  assert.ok(stepShots.length >= 3, JSON.stringify(draft.screenshots));
  assert.match(stepShots[0].label, /^After step \d+: /);
});

test('left-out steps are gone and the rest are renumbered', () => {
  const texts = picked.steps.map((s) => s.text);
  assert.ok(!texts.some((t) => /Accept terms|"Save"/.test(t)), texts.join('\n'));
  assert.deepEqual(picked.steps.map((s) => s.number), picked.steps.map((_, i) => i + 1));
  const load = picked.steps.find((s) => /Load orders/.test(s.text))!;
  // The failed call still points at the step that made it, under its new number.
  assert.equal(picked.failedApiCalls[0].step, load.number);
  assert.match(picked.actual, new RegExp(`\\(step ${load.number}\\)`));
  // API calls from a left-out step stay in the report.
  assert.ok(picked.timeline.some((e) => e.type === 'network' && e.url.endsWith('/api/ok')));
  // The ISTQB technique is still named.
  assert.ok(picked.techniques.length >= 1);
});

test('left-out screenshots are not in the report files', () => {
  assert.equal(picked.screenshot, undefined, 'page screenshot was switched off');
  const slow = picked.steps.find((s) => /Slow report/.test(s.text))!;
  assert.equal(slow.screenshot, undefined);
  const load = picked.steps.find((s) => /Load orders/.test(s.text))!;
  assert.ok(load.screenshot, 'kept screenshot is still there');
  const md = readFileSync(join(pickedDir, 'report.md'), 'utf8');
  assert.ok(md.includes(load.screenshot!));
  const dropped = draft.stepList.filter((s) => /Slow report|Accept terms|"Save"/.test(s.text)).map((s) => s.screenshot).filter(Boolean);
  for (const shot of dropped) assert.ok(!md.includes(shot!), `${shot} should be left out`);
  assert.ok(!md.includes('![Bug]'));
  const html = readFileSync(join(pickedDir, 'report.html'), 'utf8');
  assert.equal((html.match(/<figure>/g) ?? []).length, picked.steps.filter((s) => s.screenshot).length);
});

test('without a selection everything is included', () => {
  const full = buildBugReport(session, { toSeq: picked.timeline.at(-1)!.seq });
  assert.equal(full.steps.length, draft.stepList.length);
});

test('screenshot preview only serves recorded screenshots', async () => {
  const again = await startRecording({ url: demo.url, outDir, headless: true, profilesPath: join(outDir, 'p.json') });
  try {
    await again.page.waitForLoadState('load');
    await again.page.getByRole('button', { name: 'Load orders' }).click();
    await again.page.waitForTimeout(1_000);
    const call = (path: string) => again.page.evaluate((p) => (window as any).__qaPanel({ cmd: 'bugShot', path: p }), path);
    const shot = (await again.page.evaluate(() => (window as any).__qaPanel({ cmd: 'bugDraft', scope: 'session' }))).result.screenshots[0];
    const ok = await call(shot.path);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.match(ok.result, /^data:image\/png;base64,/);
    for (const bad of ['../session.json', 'screenshots/../../x.png', '/etc/passwd']) {
      assert.equal((await call(bad)).ok, false, bad);
    }

    // The Bug tab shows a checkbox per step and per screenshot.
    const tools = again.toolsPage!;
    await tools.evaluate(() => (window as any).__qaPanelUi.open());
    await tools.waitForFunction(() => !(window as any).__qaPanelUi._root.textContent.includes('Loading…'));
    await tools.evaluate(() => {
      const r = (window as any).__qaPanelUi._root as HTMLElement;
      (Array.from(r.querySelectorAll('[role=tab]')).find((b) => b.textContent === 'Bug') as HTMLElement).click();
    });
    await tools.waitForFunction(() => (window as any).__qaPanelUi._root.textContent.includes('Start bug report'));
    await tools.evaluate(() => {
      const r = (window as any).__qaPanelUi._root as HTMLElement;
      (Array.from(r.querySelectorAll('button')).find((b) => b.textContent === 'Start bug report') as HTMLElement).click();
    });
    await tools.waitForFunction(() => (window as any).__qaPanelUi._root.querySelector('[data-pick=steps]'));
    const counts = await tools.evaluate(() => {
      const r = (window as any).__qaPanelUi._root as HTMLElement;
      return {
        steps: r.querySelectorAll('[data-pick=steps] input[type=checkbox]').length,
        shots: r.querySelectorAll('[data-pick=screenshots] input[type=checkbox]').length,
        text: r.textContent,
      };
    });
    assert.ok(counts.steps >= 1);
    assert.ok(counts.shots >= 2, 'page screenshot plus the step screenshot');
    assert.match(counts.text!, /Reproduction steps \(\d+ of \d+\)/);
  } finally {
    await again.stop();
  }
});

test('report command can skip steps by number', () => {
  const full = buildBugReport(session);
  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'report', recorder.sessionDir, '--skip-steps', '2', '--title', 'Skip CLI'],
    { encoding: 'utf8' },
  );
  assert.match(out, new RegExp(`${full.steps.length - 1} steps`));
  const dir = readdirSync(join(recorder.sessionDir, 'bugs')).find((d) => d.includes('skip-cli'))!;
  const report: BugReport = JSON.parse(readFileSync(join(recorder.sessionDir, 'bugs', dir, 'bug.json'), 'utf8'));
  assert.ok(!report.steps.some((s) => s.key === full.steps[1].key));
});
