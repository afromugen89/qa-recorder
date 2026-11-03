import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  numberBoundaries, lengthBoundaries, dateBoundaries, numberPartitions, lengthPartitions,
  edgeCases, textOfLength, suggestCases,
} from '../src/data/boundaries.js';
import { DataGenerator, CATALOG, listLocales } from '../src/data/faker.js';

const values = (cases: { value: string }[]) => cases.map((c) => c.value);

test('2-value number BVA', () => {
  const cases = numberBoundaries({ min: 1, max: 100 });
  assert.deepEqual(values(cases), ['0', '1', '100', '101']);
  assert.deepEqual(cases.map((c) => c.expected), ['invalid', 'valid', 'valid', 'invalid']);
  assert.ok(cases.every((c) => c.technique === 'boundary-value-analysis'));
});

test('3-value number BVA with decimal step', () => {
  const cases = numberBoundaries({ min: 0.5, max: 10, step: 0.01, mode: '3-value' });
  assert.deepEqual(values(cases), ['0.49', '0.50', '0.51', '9.99', '10.00', '10.01']);
});

test('BVA rejects inverted ranges', () => {
  assert.throws(() => numberBoundaries({ min: 5, max: 1 }), /greater than max/);
});

test('length BVA builds strings of the exact length', () => {
  const cases = lengthBoundaries({ minLength: 3, maxLength: 50, mode: '3-value' });
  assert.deepEqual(cases.map((c) => c.value.length), [2, 3, 4, 49, 50, 51]);
  assert.equal(cases[5].expected, 'invalid');
  assert.match(cases[5].label, /51 chars/);
});

test('length BVA for email fields keeps a valid shape', () => {
  const cases = lengthBoundaries({ maxLength: 30, charset: 'email' });
  for (const c of cases.filter((c) => c.value.length > 10)) assert.match(c.value, /^a+@test\.com$/);
  assert.equal(cases.at(-1)!.value.length, 31);
});

test('ruler text marks every 10th character', () => {
  const text = textOfLength(25);
  assert.equal(text.length, 25);
  assert.equal(text[9], '1');
  assert.equal(text[19], '2');
});

test('date BVA', () => {
  const cases = dateBoundaries({ min: '2024-02-28', max: '2024-03-31' });
  assert.deepEqual(values(cases), ['2024-02-27', '2024-02-28', '2024-03-31', '2024-04-01']);
  assert.throws(() => dateBoundaries({ min: 'nope', max: '2024-01-01' }), /not a date/);
});

test('equivalence partitions', () => {
  const num = numberPartitions({ min: 1, max: 10 });
  assert.ok(num.every((c) => c.technique === 'equivalence-partitioning'));
  assert.ok(values(num).includes('abc'));
  assert.equal(num.find((c) => c.label.startsWith('valid'))!.value, '5');
  const text = lengthPartitions({ minLength: 2, maxLength: 20 });
  assert.equal(text[0].value.length, 11);
});

test('edge cases are tagged as error guessing', () => {
  const cases = edgeCases();
  assert.ok(cases.length >= 15);
  assert.ok(cases.every((c) => c.technique === 'error-guessing'));
  assert.ok(cases.some((c) => c.value.includes('<script>')));
});

test('suggests cases from field constraints', () => {
  const number = suggestCases({ type: 'number', min: '1', max: '99' });
  assert.ok(number.some((c) => c.value === '100' && c.expected === 'invalid'));
  const text = suggestCases({ type: 'text', maxLength: 10 });
  assert.ok(text.some((c) => c.value.length === 11));
  assert.deepEqual(suggestCases({ type: 'text' }), []);
});

test('every catalog type generates a value', () => {
  const gen = new DataGenerator(42);
  const options: Record<string, object> = {
    pattern: { pattern: '[A-Z]{3}-[0-9]{4}' },
    template: { template: 'user{i}.{{person.lastName}}@test.com' },
    custom: { path: 'vehicle.vin' },
  };
  for (const entry of CATALOG) {
    const value = gen.generate({ type: entry.id, options: options[entry.id] }, 7);
    assert.equal(typeof value, 'string', entry.id);
    assert.ok(value.length > 0, `${entry.id} produced an empty value`);
  }
});

test('generator options are respected', () => {
  const gen = new DataGenerator(1);
  for (const v of gen.generateMany({ type: 'integer', options: { min: 5, max: 7 } }, 50)) {
    assert.ok(Number(v) >= 5 && Number(v) <= 7, v);
  }
  assert.equal(gen.generate({ type: 'digits', options: { length: 8 } }).length, 8);
  assert.match(gen.generate({ type: 'pattern', options: { pattern: '[A-Z]{3}-[0-9]{4}' } }), /^[A-Z]{3}-\d{4}$/);
  assert.match(gen.generate({ type: 'template', options: { template: 'item-{i}' } }, 3), /^item-3$/);
  assert.match(gen.generate({ type: 'decimal', options: { min: 1, max: 2, precision: 3 } }), /^[12]\.\d{3}$/);
  assert.match(gen.generate({ type: 'custom', options: { path: 'number.int', args: '{"min": 3, "max": 3}' } }), /^3$/);
});

test('custom paths are limited to Faker methods', () => {
  const gen = new DataGenerator(1);
  assert.throws(() => gen.generate({ type: 'custom', options: { path: 'constructor.constructor' } }), /Unknown Faker method/);
  assert.throws(() => gen.generate({ type: 'custom', options: { path: 'person' } }), /Unknown Faker method/);
  assert.throws(() => gen.generate({ type: 'custom', options: { path: 'person.nope' } }), /Unknown Faker method/);
  assert.throws(() => gen.generate({ type: 'custom', options: { path: 'number.int', args: '{bad' } }), /must be JSON/);
});

test('same seed gives the same data', () => {
  const a = new DataGenerator(99).generateMany({ type: 'email' }, 5);
  const b = new DataGenerator(99).generateMany({ type: 'email' }, 5);
  assert.deepEqual(a, b);
});

test('locales', () => {
  const locales = listLocales();
  assert.equal(locales[0], 'en_US');
  assert.ok(locales.includes('de'));
  const gen = new DataGenerator(5);
  assert.ok(gen.generate({ type: 'fullName', locale: 'ja' }).length > 0);
  assert.throws(() => gen.generate({ type: 'fullName', locale: 'xx' }), /Unknown locale/);
});
