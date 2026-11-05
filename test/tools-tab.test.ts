import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRecording, TOOLS_URL } from '../src/index.js';
import type { ActionEvent } from '../src/index.js';
import { startDemo } from './fixtures/server.js';

// The QA tools used to float over the app, so they showed up in step
// screenshots (or flickered when hidden for them). They now live in a tab of
// their own and the app page has nothing of ours to hide.
test('QA tools open in their own tab and never appear in the app', async () => {
  const demo = await startDemo();
  const outDir = mkdtempSync(join(tmpdir(), 'qa-recorder-tools-'));
  const recorder = await startRecording({ url: demo.url, outDir, headless: true });
  try {
    const page = recorder.page;
    await page.waitForLoadState('load');
    const tools = recorder.toolsPage!;
    assert.ok(tools, 'tools tab is open');
    assert.equal(tools.url(), TOOLS_URL);
    assert.equal(await tools.title(), 'QA tools');
    assert.notEqual(tools.context(), recorder.context, 'tools run outside the recorded context');
    assert.deepEqual(recorder.context.pages(), [page], 'the app context only holds app tabs');

    // Watch for anything of ours being added to the app page.
    // A string, because tsx would add __name to a function with a named inner function.
    await page.evaluate(`window.__qaForeign = 0;
      new MutationObserver((list) => {
        for (const m of list) for (const n of m.addedNodes) if (n.localName && n.localName.startsWith('qa-recorder')) window.__qaForeign++;
      }).observe(document, { childList: true, subtree: true });`);
    for (let i = 0; i < 3; i++) {
      await page.mouse.click(400 + i * 5, 400);
      await page.waitForTimeout(700); // past the 400 ms screenshot delay
    }
    const shots = recorder.events.filter((e): e is ActionEvent => e.type === 'action' && Boolean(e.screenshot));
    assert.ok(shots.length > 0, 'step screenshots were taken');
    assert.equal(await page.locator('qa-recorder-panel').count(), 0);
    assert.equal(await page.evaluate('window.__qaForeign'), 0, 'nothing was added to the app page');

    // The tools act on the app tab and show its address.
    await tools.waitForFunction((url) => document.body.textContent!.includes(url), page.url());

    // Alt+Shift+D in the app is a shortcut, not a recorded step.
    const before = recorder.events.filter((e) => e.type === 'action').length;
    await page.keyboard.press('Alt+Shift+D');
    await page.waitForTimeout(300);
    assert.equal(recorder.events.filter((e) => e.type === 'action').length, before);

    // Closing the tools tab is fine; the shortcut opens it again.
    await tools.close();
    const reopened = await recorder.showTools();
    assert.ok(!reopened.isClosed());
    assert.equal(reopened.url(), TOOLS_URL);
  } finally {
    await recorder.stop();
    await demo.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('panel: false opens no tools tab', async () => {
  const demo = await startDemo();
  const outDir = mkdtempSync(join(tmpdir(), 'qa-recorder-tools-'));
  const recorder = await startRecording({ url: demo.url, outDir, headless: true, panel: false, screenshots: false });
  try {
    assert.equal(recorder.toolsPage, undefined);
  } finally {
    await recorder.stop();
    await demo.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

// Every API call used to redraw the whole QA tools page, which closed an open
// dropdown (e.g. Faker > Data type) as soon as the app made a request.
test('API calls do not redraw the QA tools under an open control', async () => {
  const demo = await startDemo();
  const outDir = mkdtempSync(join(tmpdir(), 'qa-recorder-tools-'));
  const recorder = await startRecording({ url: demo.url, outDir, headless: true, screenshots: false });
  try {
    const page = recorder.page;
    await page.waitForLoadState('load');
    const tools = recorder.toolsPage!;
    const typeSelect = tools.getByLabel('Data type');
    await typeSelect.waitFor();
    await tools.evaluate(`window.__qaRedraws = 0;
      new MutationObserver(() => window.__qaRedraws++).observe(document.getElementById('qa-tools'), { childList: true });`);

    // Not focused: background API calls leave the Faker tab alone too.
    const callsBefore = recorder.events.filter((e) => e.type === 'network').length;
    await page.evaluate(`Promise.all([fetch('/api/ok', { method: 'POST', body: '{}' }), fetch('/api/fail')])`);
    await page.waitForTimeout(800); // past the 300 ms batching in the recorder
    assert.ok(recorder.events.filter((e) => e.type === 'network').length > callsBefore, 'API calls were captured');
    assert.equal(await tools.evaluate('window.__qaRedraws'), 0, 'no redraw for calls the Faker tab does not show');

    // A dropdown in use keeps its element and focus while a redraw is due.
    await typeSelect.focus();
    await tools.evaluate(`window.__qaSelect = document.querySelector('select[aria-label="Data type"]')`);
    await page.evaluate(`fetch('/api/ok', { method: 'POST', body: '{}' })`);
    await page.goto(`${demo.url}?again`); // the app address changes, which the tools do show
    await page.waitForTimeout(800);
    assert.equal(await tools.evaluate('window.__qaRedraws'), 0, 'nothing redrawn while the dropdown is in use');
    assert.ok(await tools.evaluate(`document.activeElement === window.__qaSelect && window.__qaSelect.isConnected`));

    // Leaving the dropdown applies the update.
    await tools.evaluate(`document.activeElement.blur()`);
    await tools.waitForFunction((url) => document.body.textContent!.includes(url), page.url());
  } finally {
    await recorder.stop();
    await demo.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});
