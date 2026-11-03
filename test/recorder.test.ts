import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startRecording } from '../src/index.js';
import type { ActionEvent, NetworkEvent, SessionData } from '../src/index.js';
import { startDemo, type DemoServer } from './fixtures/server.js';

let demo: DemoServer;
let outDir: string;
let session: SessionData;
let sessionDir: string;

const actions = () => session.events.filter((e): e is ActionEvent => e.type === 'action');
const network = () => session.events.filter((e): e is NetworkEvent => e.type === 'network');
const findAction = (pred: (a: ActionEvent) => boolean, label: string) => {
  const found = actions().find(pred);
  assert.ok(found, `expected action: ${label}\nrecorded:\n${actions().map((a) => `${a.action} ${a.locator.code}`).join('\n')}`);
  return found;
};

before(async () => {
  demo = await startDemo();
  outDir = mkdtempSync(join(tmpdir(), 'qa-recorder-'));
  const recorder = await startRecording({ url: demo.url, outDir, headless: true, slowThresholdMs: 1_000 });
  sessionDir = recorder.sessionDir;
  const page = recorder.page;
  await page.waitForLoadState('load');

  // Act like a user would. Playwright input produces real browser events,
  // which is what the injected recorder listens to.
  await page.getByLabel('Email').pressSequentially('qa@example.com');
  await page.getByLabel('Password').fill('hunter2');
  await page.getByLabel('Country').selectOption('sg');
  await page.getByText('Pro').click(); // label click → radio
  await page.getByRole('checkbox', { name: 'Accept terms' }).check();
  await page.getByPlaceholder('Notes').fill('Line one');
  await page.getByPlaceholder('Notes').press('Enter'); // ignored in textarea
  await page.getByLabel('Email').press('Enter');

  await page.getByTestId('save-btn').click();
  await page.getByRole('button', { name: 'Load orders' }).click();
  await page.getByRole('button', { name: 'Slow report' }).click();
  await page.getByRole('button', { name: 'Crash' }).click();
  await page.getByRole('button', { name: 'Delete' }).nth(1).click();

  await page.getByPlaceholder('Shadow search').fill('shoes');
  await page.getByRole('button', { name: 'Shadow go' }).click();
  const closedBox = await page.locator('closed-widget').boundingBox();
  assert.ok(closedBox);
  await page.mouse.click(closedBox.x + 20, closedBox.y + 10);

  const same = page.frameLocator('#same-frame');
  await same.getByLabel('Card name').fill('Kein');
  await same.getByRole('button', { name: 'Pay' }).click();
  const cross = page.frameLocator('#cross-frame');
  await cross.getByLabel('Card name').fill('Cross');
  await cross.getByRole('button', { name: 'Pay' }).click();

  await page.waitForTimeout(1_800); // let the slow API call finish
  session = await recorder.stop();
});

after(async () => {
  await demo?.close();
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

test('coalesces typing into one fill with the final value', () => {
  const fills = actions().filter((a) => a.action === 'fill' && a.element.id === 'email');
  assert.equal(fills.length, 1);
  assert.equal(fills[0].value, 'qa@example.com');
  assert.equal(fills[0].locator.code, 'getByRole("textbox", { name: "Email", exact: true })');
});

test('masks passwords', () => {
  const pw = findAction((a) => a.element.id === 'password', 'password fill');
  assert.equal(pw.value, '********');
  assert.equal(pw.sensitive, true);
});

test('records selects, radios and checkboxes', () => {
  const select = findAction((a) => a.action === 'select', 'select');
  assert.deepEqual(select.values, ['sg']);
  assert.deepEqual(select.labels, ['Singapore']);
  const radio = findAction((a) => a.action === 'check' && a.element.type === 'radio', 'radio');
  assert.match(radio.locator.code, /getByRole\("radio", \{ name: "Pro"/);
  assert.equal(actions().filter((a) => a.element.tag === 'label').length, 0, 'label clicks are not recorded twice');
  findAction((a) => a.action === 'check' && a.element.type === 'checkbox', 'checkbox');
});

test('records Enter in inputs but not in textareas', () => {
  const presses = actions().filter((a) => a.action === 'press');
  assert.equal(presses.length, 1);
  assert.equal(presses[0].key, 'Enter');
  assert.equal(presses[0].element.id, 'email');
});

test('prefers test ids and disambiguates duplicates', () => {
  const save = findAction((a) => a.element.text === 'Save', 'save click');
  assert.equal(save.locator.code, 'getByTestId("save-btn")');
  const del = findAction((a) => a.element.text === 'Delete', 'delete click');
  assert.match(del.locator.code, /\.nth\(1\)$/);
});

test('records inside open and closed shadow DOM', () => {
  const shadowFill = findAction((a) => a.action === 'fill' && a.value === 'shoes', 'shadow fill');
  assert.equal(shadowFill.element.inShadowDom, true);
  assert.equal(shadowFill.element.inClosedShadowDom, false);
  const closed = findAction((a) => a.element.text === 'Closed action', 'closed shadow click');
  assert.equal(closed.element.inClosedShadowDom, true);
  assert.equal(actions().filter((a) => a.element.tag === 'closed-widget').length, 0, 'host click not recorded');
});

test('records inside same-origin and cross-origin iframes', () => {
  const sameFill = findAction((a) => a.value === 'Kein', 'same-origin frame fill');
  assert.equal(sameFill.framePath.length, 1);
  assert.match(sameFill.framePath[0], /Same origin|same-frame/);
  const crossFill = findAction((a) => a.value === 'Cross', 'cross-origin frame fill');
  assert.match(crossFill.framePath[0], /Cross origin|cross-frame/);
  const pays = actions().filter((a) => a.element.text === 'Pay');
  assert.equal(pays.length, 2);
});

test('captures API status, timing, failures and the triggering action', () => {
  const ok = network().find((n) => n.url.endsWith('/api/ok') && n.method === 'POST');
  assert.ok(ok);
  assert.equal(ok.status, 200);
  assert.equal(ok.isError, false);
  assert.equal(typeof ok.durationMs, 'number');
  assert.equal(ok.requestBody, '{"a":1}');
  const save = findAction((a) => a.element.text === 'Save', 'save');
  assert.equal(ok.triggeredBy, save.seq);

  const fail = network().find((n) => n.url.endsWith('/api/fail'));
  assert.ok(fail);
  assert.equal(fail.status, 500);
  assert.equal(fail.isError, true);
  assert.match(fail.responseBody ?? '', /Database timeout/);

  const slow = network().find((n) => n.url.endsWith('/api/slow'));
  assert.ok(slow);
  assert.equal(slow.isSlow, true);
  assert.ok((slow.durationMs ?? 0) >= 1_000, `slow call took ${slow.durationMs}ms`);

  assert.equal(session.summary.failedApiCalls, 1);
  assert.equal(session.summary.slowApiCalls, 1);
});

test('captures console errors and uncaught exceptions', () => {
  const consoleErrors = session.events.filter((e) => e.type === 'console' && e.level === 'error');
  assert.ok(consoleErrors.some((e) => e.type === 'console' && e.text === 'Order failed to load'));
  const pageErrors = session.events.filter((e) => e.type === 'pageerror');
  assert.ok(pageErrors.some((e) => e.type === 'pageerror' && e.message.includes('Boom from demo')));
});

test('writes session.json, HAR and screenshots', () => {
  const saved = JSON.parse(readFileSync(join(sessionDir, 'session.json'), 'utf8')) as SessionData;
  assert.equal(saved.events.length, session.events.length);
  assert.ok(existsSync(join(sessionDir, 'network.har')));
  const shot = actions().find((a) => a.screenshot);
  assert.ok(shot, 'at least one action has a screenshot');
  assert.ok(existsSync(join(sessionDir, shot.screenshot!)));
});

test('recorded locators replay on a fresh page', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(demo.url);
    for (const action of actions()) {
      if (action.element.inClosedShadowDom) continue; // Playwright cannot reach closed shadow roots
      let scope: import('playwright').Page | import('playwright').FrameLocator = page;
      for (const frameSelector of action.framePath) scope = scope.frameLocator(frameSelector);
      const count = await scope.locator(action.locator.selector).count();
      assert.equal(count, 1, `${action.action} ${action.locator.selector} in [${action.framePath}] matched ${count}`);
    }
  } finally {
    await browser.close();
  }
});
