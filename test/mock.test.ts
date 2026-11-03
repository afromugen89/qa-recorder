import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { startRecording, type Recorder } from '../src/index.js';
import type { NetworkEvent } from '../src/index.js';
import { buildBugReport } from '../src/report/bug.js';
import { renderMarkdown } from '../src/report/render.js';
import { startDemo, type DemoServer } from './fixtures/server.js';

let demo: DemoServer;
let outDir: string;
let recorder: Recorder;
let page: Page;
let mocksPath: string;

async function panel<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await page.evaluate((c) => (window as any).__qaPanel(c), { cmd, ...args });
  if (!r.ok) throw new Error(r.error);
  return r.result;
}

/** Calls the API from the page, like the app would. */
function pageFetch(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return page.evaluate(async ({ path, init }) => {
    try {
      const res = await fetch(path, init);
      return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text: await res.text() };
    } catch (error) {
      return { status: 0, headers: {}, text: '', error: String(error) };
    }
  }, { path, init });
}

const network = () => recorder.events.filter((e): e is NetworkEvent => e.type === 'network');

before(async () => {
  demo = await startDemo();
  outDir = mkdtempSync(join(tmpdir(), 'qa-recorder-mock-'));
  mocksPath = join(outDir, 'mocks.json');
  // One rule saved from an earlier session; it should load and be active.
  writeFileSync(mocksPath, JSON.stringify({ version: 1, rules: [
    { id: 'saved', name: 'Saved rule', enabled: true, url: '/api/ok', method: 'GET', response: { mode: 'modify', status: 418 } },
  ] }));
  recorder = await startRecording({ url: demo.url, outDir, headless: true, screenshots: false, mocksPath, profilesPath: join(outDir, 'p.json') });
  page = recorder.page;
  await page.waitForLoadState('load');
});

after(async () => {
  await recorder?.stop();
  await demo?.close();
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

test('loads saved rules and applies them', async () => {
  assert.equal(recorder.mocks.activeCount(), 1);
  const r = await pageFetch('/api/ok');
  assert.equal(r.status, 418);
  await panel('mockToggle', { id: 'saved', enabled: false });
  assert.equal((await pageFetch('/api/ok')).status, 200);
});

test('changes request headers and JSON body before it is sent', async () => {
  await panel('mockSave', { rule: {
    name: 'Expired token', method: 'POST', url: '/api/echo',
    request: { headers: 'Authorization: Bearer expired\n-x-remove-me', fields: 'qty = 0\nuser.role = "admin"' },
  } });
  const r = await pageFetch('/api/echo', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-remove-me': '1' }, body: JSON.stringify({ qty: 5, user: { name: 'A' } }),
  });
  const echoed = JSON.parse(r.text);
  assert.equal(echoed.headers.authorization, 'Bearer expired');
  assert.equal(echoed.headers['x-remove-me'], undefined);
  assert.deepEqual(JSON.parse(echoed.body), { qty: 0, user: { name: 'A', role: 'admin' } });
});

test('changes the real response: status, headers and fields', async () => {
  const state = await panel('mockState');
  for (const rule of state.rules) await panel('mockDelete', { id: rule.id });
  await panel('mockSave', { rule: {
    name: 'Empty cart', method: 'GET', url: '/api/echo',
    response: { mode: 'modify', status: 503, headers: 'X-Mocked: yes\n-x-server', fields: 'items = []\ntotal = 0' },
  } });
  const r = await pageFetch('/api/echo');
  assert.equal(r.status, 503);
  assert.equal(r.headers['x-mocked'], 'yes');
  assert.equal(r.headers['x-server'], undefined);
  const body = JSON.parse(r.text);
  assert.deepEqual(body.items, []);
  assert.equal(body.total, 0);
  assert.equal(body.method, 'GET', 'the real server was called');
});

test('replaces the response without calling the server, with a delay', async () => {
  await panel('mockSave', { rule: {
    name: 'Fake orders', url: '/api/orders*', delayMs: 300,
    response: { mode: 'replace', status: 201, body: '{"orders":[{"id":7}]}', headers: 'X-Fake: 1' },
  } });
  const started = Date.now();
  const r = await pageFetch('/api/orders?page=1'); // doesn't exist on the server (would be 404)
  assert.ok(Date.now() - started >= 300);
  assert.equal(r.status, 201);
  assert.equal(r.headers['x-fake'], '1');
  assert.deepEqual(JSON.parse(r.text), { orders: [{ id: 7 }] });
});

test('simulates a network failure, once', async () => {
  await panel('mockSave', { rule: { name: 'Offline', url: '/api/fail', once: true, response: { mode: 'fail', failure: 'internetdisconnected' } } });
  const first = await pageFetch('/api/fail');
  assert.equal(first.status, 0);
  assert.match(first.error ?? '', /Failed to fetch/);
  const second = await pageFetch('/api/fail');
  assert.equal(second.status, 500, 'once: the real API answers the second time');
  const state = await panel('mockState');
  assert.equal(state.rules.find((r: { name: string }) => r.name === 'Offline').enabled, false);
});

test('mocked calls are flagged in the recording', async () => {
  await page.waitForTimeout(300);
  const mocked = network().filter((n) => n.mock);
  assert.ok(mocked.length >= 5);
  const offline = mocked.find((n) => n.mock!.rule === 'Offline');
  assert.equal(offline?.failure, 'net::ERR_INTERNET_DISCONNECTED');
  const fake = mocked.find((n) => n.mock!.rule === 'Fake orders');
  assert.equal(fake?.status, 201);
  assert.ok(fake?.mock?.changes.some((c) => c.includes('server not called')));
  const empty = mocked.find((n) => n.mock!.rule === 'Empty cart');
  assert.ok(empty?.mock?.changes.includes('status 200 → 503'));
  assert.equal(empty?.isError, true);
});

test('"Mock this" turns a recent call into an editable rule', async () => {
  await pageFetch('/api/ok');
  await page.waitForTimeout(400);
  const state = await panel('mockState');
  const call = state.recent.find((c: { url: string }) => c.url.endsWith('/api/ok'));
  assert.ok(call);
  const draft = await panel('mockFromCall', { seq: call.seq });
  assert.equal(draft.method, 'GET');
  assert.equal(draft.url, '/api/ok');
  assert.equal(draft.response.status, 200);
  assert.equal(draft.response.body, '{"ok":true}');
});

test('rules are saved to the mocks file for sharing', () => {
  const saved = JSON.parse(readFileSync(mocksPath, 'utf8'));
  assert.deepEqual(saved.rules.map((r: { name: string }) => r.name).sort(), ['Empty cart', 'Fake orders', 'Offline']);
  assert.ok(saved.rules.every((r: object) => !('hits' in r)));
});

test('bug reports warn that mocks were used', () => {
  const report = buildBugReport(recorder.snapshot());
  assert.ok(report.mocks.some((m) => m.rule === 'Empty cart'));
  assert.ok(report.failedApiCalls.some((c) => c.mock === 'Empty cart'));
  const md = renderMarkdown(report);
  assert.match(md, /> ⚠️ API mocks were active/);
  assert.match(md, /## API mocks used/);
  assert.match(md, /\(mocked: Empty cart\)/);
});

test('invalid rules are rejected with a clear message', async () => {
  await assert.rejects(panel('mockSave', { rule: { url: '/x', response: { mode: 'modify', status: 42 } } }), /100 and 599/);
  await assert.rejects(panel('mockSave', { rule: { url: '/x', request: { fields: 'oops' } } }), /path = value/);
});
