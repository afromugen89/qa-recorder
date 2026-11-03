import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { startRecording, type Recorder } from '../src/index.js';
import type { ActionEvent, LoopEvent } from '../src/index.js';
import { startDemo, type DemoServer } from './fixtures/server.js';

let demo: DemoServer;
let outDir: string;
let recorder: Recorder;
let page: Page;

type PanelResponse<T> = { ok: true; result: T } | { ok: false; error: string };

/** Sends a command the same way the panel UI does. */
async function panel<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = (await page.evaluate(
    (c) => (window as any).__qaPanel(c),
    { cmd, ...args },
  )) as PanelResponse<T>;
  if (!response.ok) throw new Error(response.error);
  return response.result;
}

async function focusField(label: string) {
  await page.getByLabel(label, { exact: true }).click();
  // Wait until Node has the target and pushed it to the panel.
  await page.waitForFunction(
    (l) => {
      const ui = (window as any).__qaPanelUi;
      return ui && (window as any).__lastTargetLabel === l;
    },
    label,
    { timeout: 5_000 },
  ).catch(async () => {
    // Fallback: poll via init.
    for (let i = 0; i < 50; i++) {
      const init = await panel<{ target: { label: string } | null }>('init');
      if (init.target?.label === label) return;
      await page.waitForTimeout(100);
    }
    throw new Error(`target never became ${label}`);
  });
}

const actions = () => recorder.events.filter((e): e is ActionEvent => e.type === 'action');
const lastActionFor = (id: string) => actions().filter((a) => a.element.id === id).at(-1);

before(async () => {
  demo = await startDemo();
  outDir = mkdtempSync(join(tmpdir(), 'qa-recorder-data-'));
  recorder = await startRecording({
    url: `${demo.url}/data.html`,
    outDir,
    headless: true,
    screenshots: false,
    seed: 1234,
    profilesPath: join(outDir, 'profiles.json'),
  });
  page = recorder.page;
  await page.waitForLoadState('load');
  // Let tests know when Node pushed a new target.
  await page.evaluate(() => {
    const ui = (window as any).__qaPanelUi;
    const original = ui.setTarget.bind(ui);
    ui.setTarget = (t: { label: string }) => {
      (window as any).__lastTargetLabel = t.label;
      original(t);
    };
  });
});

after(async () => {
  await recorder?.stop();
  await demo?.close();
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

test('reports the focused field and its constraints', async () => {
  await focusField('Name');
  const init = await panel('init');
  assert.equal(init.target.label, 'Name');
  assert.equal(init.target.constraints.maxLength, 20);
  assert.equal(init.target.constraints.minLength, 2);
  assert.equal(init.target.constraints.required, true);
  assert.ok(init.target.suggestions.some((c: { value: string }) => c.value.length === 21), 'suggests max+1');
  assert.ok(init.catalog.length > 30);
  assert.equal(init.seed, 1234);
});

test('boundary value max+1 is cut by maxlength, like a real user would see', async () => {
  await focusField('Name');
  const [maxPlusOne] = (await panel<any[]>('cases', { kind: 'length', min: 2, max: 20 })).filter((c) => c.label.startsWith('max + 1'));
  const r = await panel('fillValue', { value: maxPlusOne });
  assert.equal(r.truncated, true);
  assert.equal(r.acceptedLength, 20);
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), maxPlusOne.value.slice(0, 20));

  await page.waitForTimeout(200);
  const action = lastActionFor('name');
  assert.equal(action?.testData?.technique, 'boundary-value-analysis');
  assert.equal(action?.testData?.expected, 'invalid');
  assert.match(action?.testData?.label ?? '', /max \+ 1/);
});

test('maxlength can be bypassed to test server-side validation', async () => {
  await focusField('Name');
  const r = await panel('fillValue', { value: { value: 'x'.repeat(25), label: 'too long', kind: 'boundary' }, bypassMaxLength: true });
  assert.equal(r.acceptedLength, 25);
});

test('fills the focused field with a Faker value the QA chose', async () => {
  await focusField('Email');
  const r = await panel('fillGenerated', { spec: { type: 'safeEmail', locale: 'en_US' } });
  assert.match(r.value, /@example\.(com|net|org)$/);
  assert.equal(await page.getByLabel('Email').inputValue(), r.value);
  await page.waitForTimeout(200);
  const action = lastActionFor('email');
  assert.equal(action?.value, r.value);
  assert.equal(action?.testData?.source, 'faker');
  assert.equal(action?.testData?.technique, 'random-testing');
  assert.equal(action?.testData?.spec?.type, 'safeEmail');
});

test('suggests number and date boundaries from min and max attributes', async () => {
  await focusField('Quantity');
  const init = await panel('init');
  const values = init.target.suggestions.map((c: { value: string }) => c.value);
  for (const v of ['0', '1', '99', '100']) assert.ok(values.includes(v), `missing ${v}`);
  await focusField('Due date');
  const dates = (await panel('init')).target.suggestions.map((c: { value: string }) => c.value);
  assert.deepEqual(dates, ['2025-12-31', '2026-01-01', '2026-12-31', '2027-01-01']);
});

test('error-guessing values are tagged', async () => {
  await focusField('Name');
  const init = await panel('init');
  const xss = init.edgeCases.find((c: { value: string }) => c.value.includes('<script>'));
  await panel('fillValue', { value: { ...xss, kind: 'edge-case' } });
  await page.waitForTimeout(200);
  assert.equal(lastActionFor('name')?.testData?.technique, 'error-guessing');
});

test('data profiles fill a whole form and are saved to disk', async () => {
  await focusField('Name');
  await panel('addToProfile', { profile: 'New item', spec: { type: 'productName' } });
  await focusField('Email');
  const profiles = await panel('addToProfile', { profile: 'New item', spec: { type: 'safeEmail' } });
  assert.equal(profiles[0].fields.length, 2);
  const saved = JSON.parse(readFileSync(join(outDir, 'profiles.json'), 'utf8'));
  assert.equal(saved.profiles[0].name, 'New item');

  await page.getByLabel('Name', { exact: true }).fill('');
  await page.getByLabel('Email').fill('');
  const r = await panel('applyProfile', { profile: 'New item' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.filled.length, 2);
  assert.equal(await page.getByLabel('Email').inputValue(), r.filled[1].value);
  await page.waitForTimeout(200);
  assert.equal(lastActionFor('email')?.testData?.source, 'profile');
});

test('looper repeats a captured flow with fresh data each time', async () => {
  await panel('captureStart');
  await page.getByLabel('Name', { exact: true }).fill('First');
  await page.getByLabel('Email').fill('first@example.com');
  await page.getByRole('button', { name: 'Add' }).click();
  await page.waitForTimeout(300);
  const captured = await panel('captureEnd');
  assert.equal(captured.state, 'captured');
  assert.deepEqual(captured.steps.map((s: { action: string }) => s.action), ['fill', 'fill', 'click']);

  const [nameStep, emailStep] = captured.steps;
  const result = await panel('loopRun', {
    options: {
      iterations: 3,
      delayMs: 0,
      values: {
        [nameStep.seq]: { mode: 'generate', spec: { type: 'template', options: { template: 'Item {i}' } } },
        [emailStep.seq]: { mode: 'generate', spec: { type: 'safeEmail' } },
      },
    },
  });
  assert.equal(result.results.length, 3);
  assert.ok(result.results.every((r: { ok: boolean }) => r.ok), JSON.stringify(result.results));

  const items = await page.locator('#items li').allTextContents();
  assert.equal(items.length, 4);
  assert.deepEqual(items.slice(1).map((t) => t.split(' <')[0]), ['Item 1', 'Item 2', 'Item 3']);
  const emails = items.slice(1).map((t) => t.split(' <')[1]);
  assert.equal(new Set(emails).size, 3, 'each iteration gets a new email');

  await page.waitForTimeout(200);
  const looped = actions().filter((a) => a.loop);
  assert.equal(looped.length, 9);
  assert.deepEqual([...new Set(looped.map((a) => a.loop!.iteration))], [1, 2, 3]);
  assert.equal(looped.find((a) => a.element.id === 'name')?.testData?.source, 'loop');

  const loopEvents = recorder.events.filter((e): e is LoopEvent => e.type === 'loop').map((e) => e.phase);
  assert.deepEqual(loopEvents, ['capture-start', 'capture-end', 'run-start', 'iteration', 'iteration', 'iteration', 'run-end']);

  const posts = recorder.events.filter((e) => e.type === 'network' && e.method === 'POST');
  assert.equal(posts.length, 4, 'API calls from each iteration are captured');
});

test('panel UI renders and is invisible to the recorder and to Playwright locators', async () => {
  const before = actions().length;
  await page.keyboard.press('Alt+Shift+D');
  await page.waitForFunction(() => (window as any).__qaPanelUi._root.querySelector('[role=dialog] .tabs'));
  const tabs = await page.evaluate(() =>
    Array.from((window as any).__qaPanelUi._root.querySelectorAll('[role=tab]')).map((b: any) => b.textContent),
  );
  assert.deepEqual(tabs, ['Faker', 'Boundaries', 'Edge cases', 'Profiles', 'Looper', 'Mock', 'Bug']);

  // Click the Edge cases tab inside the panel.
  await page.evaluate(() => {
    const root = (window as any).__qaPanelUi._root;
    Array.from(root.querySelectorAll('[role=tab]')).find((b: any) => b.textContent === 'Edge cases')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    );
  });
  const rows = await page.evaluate(() => (window as any).__qaPanelUi._root.querySelectorAll('li').length);
  assert.ok(rows > 10);

  assert.equal(actions().length, before, 'panel clicks are not recorded');
  assert.equal(await page.getByRole('button', { name: 'Fill' }).count(), 0, 'Playwright cannot see panel buttons');
});
