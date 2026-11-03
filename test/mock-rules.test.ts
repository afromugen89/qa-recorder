import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFieldEdits, applyHeaderEdits, ruleMatches, urlMatcher, validateRule } from '../src/mock/rules.js';

test('URL patterns: substring, wildcard and regex', () => {
  assert.ok(urlMatcher('/api/orders')('https://shop.test/api/orders?page=2'));
  assert.ok(!urlMatcher('/api/orders')('https://shop.test/api/users'));
  assert.ok(urlMatcher('/api/orders/*')('https://shop.test/api/orders/42'));
  assert.ok(urlMatcher('*/orders/*/items')('https://shop.test/v2/orders/42/items'));
  assert.ok(urlMatcher('/orders\\/\\d+$/')('https://shop.test/api/orders/42'));
  assert.ok(!urlMatcher('/orders\\/\\d+$/')('https://shop.test/api/orders/abc'));
  assert.throws(() => urlMatcher('/[/'), /Invalid regular expression/);
});

test('rules match on method and only when on', () => {
  const rule = { id: '1', name: 'x', enabled: true, method: 'POST', url: '/api/orders', response: { mode: 'fail' as const } };
  assert.ok(ruleMatches(rule, 'post', 'https://a/api/orders'));
  assert.ok(!ruleMatches(rule, 'GET', 'https://a/api/orders'));
  assert.ok(!ruleMatches({ ...rule, enabled: false }, 'POST', 'https://a/api/orders'));
  assert.ok(ruleMatches({ ...rule, method: undefined }, 'GET', 'https://a/api/orders'));
});

test('header edits set and remove, case-insensitively', () => {
  const { headers, changes } = applyHeaderEdits({ 'Content-Type': 'text/plain', 'X-Trace': '1' }, 'Authorization: Bearer abc\n-x-trace\ncontent-type: application/json');
  assert.deepEqual(headers, { 'content-type': 'application/json', authorization: 'Bearer abc' });
  assert.equal(changes.length, 3);
  assert.throws(() => applyHeaderEdits({}, 'no colon here'), /Name: value/);
});

test('field edits change nested JSON, arrays and remove keys', () => {
  const body = JSON.stringify({ data: { items: [{ price: 10 }, { price: 20 }], user: { email: 'a@b.c', name: 'A' } } });
  const { body: out } = applyFieldEdits(body, 'data.items[0].price = 0\ndata.user.role = "admin"\n-data.user.email\ndata.flag = true\ndata.note = plain text\n-data.items[1]');
  assert.deepEqual(JSON.parse(out), {
    data: { items: [{ price: 0 }], user: { name: 'A', role: 'admin' }, flag: true, note: 'plain text' },
  });
  assert.deepEqual(JSON.parse(applyFieldEdits('', 'a.b[0] = 1').body), { a: { b: [1] } });
  assert.throws(() => applyFieldEdits('<html>', 'a = 1'), /JSON body/);
});

test('rules are validated', () => {
  assert.throws(() => validateRule({ id: '1', name: '', enabled: true, url: '' }), /URL/);
  assert.throws(() => validateRule({ id: '1', name: '', enabled: true, url: '/a' }), /changes nothing/);
  assert.throws(() => validateRule({ id: '1', name: '', enabled: true, url: '/a', response: { mode: 'modify', status: 999 } }), /100 and 599/);
  validateRule({ id: '1', name: '', enabled: true, url: '/a', delayMs: 500 });
});
