import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRecording } from '../src/index.js';
import type { ActionEvent } from '../src/index.js';
import { startDemo } from './fixtures/server.js';

// Regression: the screenshot taken after every action used to hide the panel
// on the live page while capturing, so the panel flickered on each click.
test('the panel stays on screen while step screenshots are taken', async () => {
  const demo = await startDemo();
  const outDir = mkdtempSync(join(tmpdir(), 'qa-recorder-flicker-'));
  const recorder = await startRecording({ url: demo.url, outDir, headless: true });
  try {
    const page = recorder.page;
    await page.waitForLoadState('load');
    await page.waitForSelector('qa-recorder-panel', { state: 'attached' });
    // Count animation frames in which the panel is missing or hidden.
    // A string, because tsx would add __name to a function with a named inner function.
    await page.evaluate(`window.__qaHiddenFrames = 0;
      (function watch() {
        const el = document.querySelector('qa-recorder-panel');
        if (!el || getComputedStyle(el).display === 'none') window.__qaHiddenFrames++;
        requestAnimationFrame(watch);
      })();`);
    for (let i = 0; i < 4; i++) {
      await page.mouse.click(400 + i * 5, 400);
      await page.waitForTimeout(700); // past the 400 ms screenshot delay
    }
    const shots = recorder.events.filter((e): e is ActionEvent => e.type === 'action' && Boolean(e.screenshot));
    assert.ok(shots.length > 0, 'step screenshots were taken');
    assert.equal(await page.evaluate('window.__qaHiddenFrames'), 0, 'panel was hidden during a screenshot');
  } finally {
    await recorder.stop();
    await demo.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});
