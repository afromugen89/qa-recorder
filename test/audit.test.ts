import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { startRecording, type Recorder } from '../src/index.js';
import { criterionFromTag, wcagTags, type A11yResult } from '../src/audit/a11y.js';
import { boundaryWidths, layoutTargets, parseBreakpoints, type LayoutResult } from '../src/audit/layout.js';
import { startDemo, type DemoServer } from './fixtures/server.js';

// ---------- pure helpers ----------

test('wcagTags includes earlier versions and lower levels', () => {
  assert.deepEqual(wcagTags('2.0', 'A'), ['wcag2a']);
  assert.deepEqual(wcagTags('2.1', 'AA'), ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  assert.deepEqual(wcagTags('2.2', 'AA', true), ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa', 'best-practice']);
  assert.ok(wcagTags('2.2', 'AAA').includes('wcag2aaa'));
});

test('criterionFromTag reads WCAG success criteria', () => {
  assert.equal(criterionFromTag('wcag143'), '1.4.3');
  assert.equal(criterionFromTag('wcag1412'), '1.4.12');
  assert.equal(criterionFromTag('wcag2aa'), undefined);
  assert.equal(criterionFromTag('best-practice'), undefined);
});

test('parseBreakpoints finds the last width before each switch', () => {
  const found = parseBreakpoints([
    '(min-width: 768px)',
    'screen and (max-width: 1023.98px)',
    '(width >= 40em)',
    '(400px < width)',
    '(min-device-width: 500px)', // device-width is not the viewport
    '(min-height: 600px)',
    'print',
  ]);
  assert.deepEqual(found.map((b) => b.below), [400, 639, 767, 1023]);
  assert.match(found.find((b) => b.below === 767)!.condition, /min-width: 768px/);
  const widths = boundaryWidths(found.filter((b) => b.below === 767));
  assert.deepEqual(widths.map((w) => w.width), [767, 768]);
});

test('layoutTargets resolves presets, landscape and custom widths', () => {
  const targets = layoutTargets({ presets: ['iPhone SE (3rd gen)', 'laptop'], landscape: true, widths: [360] });
  assert.deepEqual(targets.map((t) => `${t.width}x${t.height}`), ['667x375', '1366x768', '360x800']);
  assert.equal(targets[0].device, 'iPhone SE (3rd gen) landscape');
  assert.throws(() => layoutTargets({ widths: [50] }), /between 200 and 4000/);
  assert.throws(() => layoutTargets({ presets: ['Nokia 3310'] }), /Unknown viewport/);
});

// ---------- in the browser ----------

let demo: DemoServer;
let outDir: string;
let recorder: Recorder;
let page: Page;

type PanelResponse<T> = { ok: true; result: T } | { ok: false; error: string };
async function panel<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = (await page.evaluate((c) => (window as any).__qaPanel(c), { cmd, ...args })) as PanelResponse<T>;
  if (!response.ok) throw new Error(response.error);
  return response.result;
}

before(async () => {
  demo = await startDemo();
  outDir = mkdtempSync(join(tmpdir(), 'qa-recorder-audit-'));
  recorder = await startRecording({
    url: `${demo.url}/a11y.html`,
    outDir,
    headless: true,
    screenshots: false,
    profilesPath: join(outDir, 'profiles.json'),
    mocksPath: join(outDir, 'mocks.json'),
  });
  page = recorder.page;
  await page.waitForLoadState('load');
});

after(async () => {
  await recorder?.stop();
  await demo?.close();
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

test('accessibility scan finds WCAG violations, including inside iframes', async () => {
  const scan = await panel<{ result: A11yResult; summary: string; screenshot: string }>('a11yScan', { options: { version: '2.2', level: 'AA' } });
  const ids = scan.result.violations.map((v) => v.id);
  for (const id of ['image-alt', 'button-name', 'color-contrast', 'meta-viewport']) assert.ok(ids.includes(id), `${id} in ${ids}`);
  assert.equal(scan.result.standard, 'WCAG 2.2 AA');
  assert.match(scan.summary, /^WCAG 2\.2 AA: \d+ rules failed/);

  const alt = scan.result.violations.find((v) => v.id === 'image-alt')!;
  assert.deepEqual(alt.wcag, ['1.1.1']);
  assert.equal(alt.level, 'A');
  assert.equal(alt.impact, 'critical');
  assert.ok(alt.nodes.some((n) => n.target.length === 2), 'the image in the iframe is found');
  // Worst first.
  assert.equal(scan.result.violations[0].impact, 'critical');
  // The QA panel itself is never reported.
  assert.ok(!JSON.stringify(scan.result).includes('qa-recorder-panel'));

  assert.ok(existsSync(join(recorder.sessionDir, scan.screenshot)));
  const event = recorder.events.find((e) => e.type === 'a11y');
  assert.ok(event);
});

test('level A leaves out AA rules like colour contrast', async () => {
  const scan = await panel<{ result: A11yResult }>('a11yScan', { options: { version: '2.0', level: 'A' } });
  const ids = scan.result.violations.map((v) => v.id);
  assert.ok(ids.includes('image-alt'));
  assert.ok(!ids.includes('color-contrast'));
});

test('Show outlines a failing element on the page', async () => {
  const scan = await panel<{ result: A11yResult }>('a11yScan', { options: {} });
  const node = scan.result.violations.find((v) => v.id === 'button-name')!.nodes[0];
  assert.equal(await panel('a11yShow', { target: node.target, label: '1' }), true);
  assert.equal(await page.locator('qa-recorder-overlay').count(), 1);
});

test('finds CSS breakpoints, including in stylesheets from another origin', async () => {
  const found = await panel<{ breakpoints: { below: number }[]; boundaries: { width: number }[] }>('breakpoints');
  const below = found.breakpoints.map((b) => b.below);
  assert.ok(below.includes(767) && below.includes(1023) && below.includes(1199), String(below));
  assert.ok(found.boundaries.some((b) => b.width === 768));
});

test('layout check finds phone problems and leaves the recorded tab alone', async () => {
  const before = page.viewportSize();
  const check = await panel<{ result: LayoutResult; summary: string }>('layoutCheck', {
    request: { presets: ['iPhone SE (3rd gen)', 'laptop'], boundaries: [{ width: 767, reason: 'last width before min-width: 768px' }], current: true },
  });
  const [current, phone, laptop, boundary] = check.result.viewports;
  assert.equal(check.result.viewports.length, 4);
  assert.equal(current.fresh, false);
  assert.deepEqual(page.viewportSize(), before);

  const kinds = new Set(phone.issues.map((i) => i.kind));
  for (const kind of ['horizontal-scroll', 'overflow', 'small-target', 'overlap', 'small-text', 'zoom-disabled']) {
    assert.ok(kinds.has(kind as never), `${kind} in ${[...kinds]}`);
  }
  assert.equal(phone.device, 'iPhone SE (3rd gen)');
  assert.ok(phone.issues.find((i) => i.kind === 'overflow')!.target);
  assert.ok(!laptop.issues.some((i) => i.severity === 'error'), JSON.stringify(laptop.issues));
  assert.equal(boundary.width, 767);
  assert.ok(boundary.boundary);
  for (const v of check.result.viewports) assert.ok(v.screenshot && existsSync(join(recorder.sessionDir, v.screenshot)), v.label);
  assert.match(check.summary, /errors? .* at \d of 4 sizes/);
});

test('resizing the tab is recorded and can be undone', async () => {
  const resized = await panel('resize', { preset: 'iPhone SE (3rd gen)' });
  assert.equal(resized.width, 375);
  assert.deepEqual(page.viewportSize(), { width: 375, height: 667 });
  await panel('resize', { reset: true });
  assert.deepEqual(page.viewportSize(), { width: 1280, height: 800 });
  const events = recorder.events.filter((e) => e.type === 'viewport');
  assert.equal(events.length, 2);
  await assert.rejects(panel('resize', { width: 50 }), /between 200 and 4000/);
});

test('bug report includes the checks, their steps and the ISTQB technique', async () => {
  const draft = await panel('bugDraft', { scope: 'session' });
  assert.ok(draft.a11yViolations > 0);
  assert.ok(draft.layoutIssues > 0);
  assert.match(draft.title, /^Accessibility: /);
  assert.ok(draft.techniques.some((t: { id: string }) => t.id === 'checklist-based-testing'));
  assert.ok(draft.techniques.some((t: { id: string }) => t.id === 'boundary-value-analysis'));

  const written = await recorder.createBug({ title: 'Checkout is not accessible on phones' });
  const r = written.report;
  assert.equal(r.accessibility.length, 3);
  assert.equal(r.layout.length, 1);
  assert.ok(r.steps.some((s) => /^Run an accessibility check \(WCAG 2\.2 AA\)/.test(s.text)));
  assert.ok(r.steps.some((s) => /^Check the responsive layout/.test(s.text)));
  assert.ok(r.steps.some((s) => s.text === 'Resize the browser view to 375×667 (iPhone SE (3rd gen))'));

  const md = readFileSync(written.markdown, 'utf8');
  assert.match(md, /## Accessibility: WCAG 2\.2 AA/);
  assert.match(md, /\| \d \| Images must have alternative text \(`image-alt`\) \| critical \| 1\.1\.1 \(A\) \| 2 \|/);
  assert.match(md, /## Responsive layout/);
  assert.match(md, /Pinch zoom is blocked/);
  const html = readFileSync(written.html, 'utf8');
  assert.match(html, /<h2>Accessibility: WCAG 2\.2 AA<\/h2>/);
  assert.match(html, /How to fix/);
  assert.ok((html.match(/data:image\/png;base64/g) ?? []).length >= 5, 'check screenshots are embedded');
});

test('panel shows the Accessibility and Responsive tabs', async () => {
  const tools = recorder.toolsPage!;
  await tools.evaluate(() => (window as any).__qaPanelUi.open());
  const root = () => tools.evaluate(() => (window as any).__qaPanelUi._root.textContent as string);
  await tools.waitForFunction(() => !(window as any).__qaPanelUi._root.textContent.includes('Loading…'));
  const click = (label: string) => tools.evaluate((l) => {
    const r = (window as any).__qaPanelUi._root as HTMLElement;
    [...r.querySelectorAll('button')].find((b) => b.textContent === l)!.click();
  }, label);
  await click('Accessibility');
  assert.match(await root(), /Scan this page/);
  await click('Scan this page');
  await tools.waitForFunction(() => /rules failed/.test((window as any).__qaPanelUi._root.textContent));
  await click('Responsive');
  assert.match(await root(), /Run layout check/);
  assert.match(await root(), /iPhone SE \(3rd gen\) 375/);
});

test('recording as a device emulates a phone', async () => {
  const phone = await startRecording({ url: `${demo.url}/a11y.html`, outDir, headless: true, screenshots: false, panel: false, device: 'Pixel 7' });
  try {
    const info = await phone.page.evaluate(() => ({ width: innerWidth, touch: navigator.maxTouchPoints, ua: navigator.userAgent }));
    assert.equal(info.width, 412);
    assert.ok(info.touch > 0);
    assert.match(info.ua, /Android/);
    assert.equal(phone.snapshot().meta.device, 'Pixel 7');
  } finally {
    await phone.stop();
  }
  await assert.rejects(startRecording({ outDir, headless: true, device: 'Nokia 3310' }), /Unknown device/);
});
