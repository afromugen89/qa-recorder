import type { TechniqueId } from './techniques.js';

/** One test input, with what the field is expected to do with it. */
export interface TestValue {
  label: string;
  value: string;
  /** Whether a correct implementation should accept the value. */
  expected: 'valid' | 'invalid';
  technique: TechniqueId;
  /** Short reason the case exists. */
  why?: string;
}

export type BvaMode = '2-value' | '3-value';

export interface NumberRange {
  min: number;
  max: number;
  /** Smallest step between valid values. Default 1. Use 0.01 for money. */
  step?: number;
  mode?: BvaMode;
}

export interface LengthRange {
  minLength?: number;
  maxLength: number;
  mode?: BvaMode;
  /** What the text is made of. `email` builds a valid-looking address of the exact length. */
  charset?: 'text' | 'digits' | 'email';
}

export interface DateRange {
  /** YYYY-MM-DD */
  min: string;
  /** YYYY-MM-DD */
  max: string;
  mode?: BvaMode;
}

function decimals(step: number): number {
  const text = String(step);
  return text.includes('.') ? text.split('.')[1].length : 0;
}

function fmt(value: number, step: number): string {
  return value.toFixed(decimals(step));
}

function assertRange(min: number, max: number, what: string) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error(`${what}: min and max must be numbers`);
  if (min > max) throw new Error(`${what}: min (${min}) is greater than max (${max})`);
}

/**
 * Boundary values for a numeric range. 2-value BVA tests each boundary and its
 * nearest invalid neighbour; 3-value BVA adds the nearest valid neighbour.
 */
export function numberBoundaries({ min, max, step = 1, mode = '2-value' }: NumberRange): TestValue[] {
  assertRange(min, max, 'Number range');
  if (!(step > 0)) throw new Error('Step must be greater than 0');
  const t: TechniqueId = 'boundary-value-analysis';
  const cases: TestValue[] = [
    { label: 'min - step', value: fmt(min - step, step), expected: 'invalid', technique: t, why: 'just below the lower boundary' },
    { label: 'min', value: fmt(min, step), expected: 'valid', technique: t, why: 'lower boundary' },
  ];
  if (mode === '3-value' && min + step < max) {
    cases.push({ label: 'min + step', value: fmt(min + step, step), expected: 'valid', technique: t, why: 'just above the lower boundary' });
  }
  if (mode === '3-value' && max - step > min + step) {
    cases.push({ label: 'max - step', value: fmt(max - step, step), expected: 'valid', technique: t, why: 'just below the upper boundary' });
  }
  if (max !== min) cases.push({ label: 'max', value: fmt(max, step), expected: 'valid', technique: t, why: 'upper boundary' });
  cases.push({ label: 'max + step', value: fmt(max + step, step), expected: 'invalid', technique: t, why: 'just above the upper boundary' });
  return cases;
}

/** Text of an exact length. Digits repeat 1234567890 so the length can be read off the screen. */
export function textOfLength(length: number, charset: LengthRange['charset'] = 'text'): string {
  if (length <= 0) return '';
  if (charset === 'digits') return '1234567890'.repeat(Math.ceil(length / 10)).slice(0, length);
  if (charset === 'email') {
    const domain = '@test.com';
    if (length < domain.length + 1) return 'a'.repeat(length);
    return `${'a'.repeat(length - domain.length)}${domain}`;
  }
  // "abcdefghi0abcdefghi1..." puts a digit at every 10th position as a ruler.
  let out = '';
  for (let i = 1; out.length < length; i++) out += `abcdefghi${i % 10}`;
  return out.slice(0, length);
}

/** Boundary values for text length (e.g. a field with minlength/maxlength). */
export function lengthBoundaries({ minLength = 0, maxLength, mode = '2-value', charset = 'text' }: LengthRange): TestValue[] {
  assertRange(minLength, maxLength, 'Length range');
  if (minLength < 0) throw new Error('Minimum length cannot be negative');
  const t: TechniqueId = 'boundary-value-analysis';
  const make = (length: number, label: string, expected: TestValue['expected'], why: string): TestValue => ({
    label: `${label} (${length} ${length === 1 ? 'char' : 'chars'})`,
    value: textOfLength(length, charset),
    expected,
    technique: t,
    why,
  });
  const cases: TestValue[] = [];
  if (minLength > 0) cases.push(make(minLength - 1, 'min - 1', 'invalid', 'one character too short'));
  cases.push(make(minLength, 'min', 'valid', minLength === 0 ? 'empty input' : 'shortest allowed'));
  if (mode === '3-value' && minLength + 1 < maxLength) cases.push(make(minLength + 1, 'min + 1', 'valid', 'one above the shortest'));
  if (mode === '3-value' && maxLength - 1 > minLength + 1) cases.push(make(maxLength - 1, 'max - 1', 'valid', 'one below the longest'));
  if (maxLength !== minLength) cases.push(make(maxLength, 'max', 'valid', 'longest allowed'));
  cases.push(make(maxLength + 1, 'max + 1', 'invalid', 'one character too long'));
  return cases;
}

function parseDate(value: string): Date {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`"${value}" is not a date (use YYYY-MM-DD)`);
  return date;
}

function addDays(date: Date, days: number): string {
  return new Date(date.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Boundary values for a date range, one day apart. */
export function dateBoundaries({ min, max, mode = '2-value' }: DateRange): TestValue[] {
  const lo = parseDate(min);
  const hi = parseDate(max);
  if (lo > hi) throw new Error(`Date range: ${min} is after ${max}`);
  const days = Math.round((hi.getTime() - lo.getTime()) / 86_400_000);
  const t: TechniqueId = 'boundary-value-analysis';
  const cases: TestValue[] = [
    { label: 'day before min', value: addDays(lo, -1), expected: 'invalid', technique: t },
    { label: 'min', value: addDays(lo, 0), expected: 'valid', technique: t },
  ];
  if (mode === '3-value' && days > 1) cases.push({ label: 'day after min', value: addDays(lo, 1), expected: 'valid', technique: t });
  if (mode === '3-value' && days > 2) cases.push({ label: 'day before max', value: addDays(hi, -1), expected: 'valid', technique: t });
  if (days > 0) cases.push({ label: 'max', value: addDays(hi, 0), expected: 'valid', technique: t });
  cases.push({ label: 'day after max', value: addDays(hi, 1), expected: 'invalid', technique: t });
  return cases;
}

/** One representative per partition of a numeric range. */
export function numberPartitions({ min, max, step = 1 }: NumberRange): TestValue[] {
  assertRange(min, max, 'Number range');
  const t: TechniqueId = 'equivalence-partitioning';
  const middle = min + Math.floor((max - min) / 2 / step) * step;
  const span = Math.max(step, max - min);
  const cases: TestValue[] = [
    { label: 'valid (middle of range)', value: fmt(middle, step), expected: 'valid', technique: t },
    { label: 'below range', value: fmt(min - span, step), expected: 'invalid', technique: t },
    { label: 'above range', value: fmt(max + span, step), expected: 'invalid', technique: t },
    { label: 'not a number', value: 'abc', expected: 'invalid', technique: t },
    { label: 'empty', value: '', expected: 'invalid', technique: t, why: 'invalid if the field is required' },
  ];
  if (decimals(step) === 0) {
    cases.push({ label: 'decimal in a whole-number field', value: `${fmt(middle, step)}.5`, expected: 'invalid', technique: t });
  }
  if (min >= 0) cases.push({ label: 'negative', value: fmt(-Math.max(step, 1), step), expected: 'invalid', technique: t });
  return cases;
}

/** One representative per partition of a text length range. */
export function lengthPartitions({ minLength = 0, maxLength, charset = 'text' }: LengthRange): TestValue[] {
  assertRange(minLength, maxLength, 'Length range');
  const t: TechniqueId = 'equivalence-partitioning';
  const mid = Math.max(minLength, Math.floor((minLength + maxLength) / 2));
  const cases: TestValue[] = [
    { label: `valid length (${mid} chars)`, value: textOfLength(mid, charset), expected: 'valid', technique: t },
    { label: `far too long (${maxLength * 2 + 10} chars)`, value: textOfLength(maxLength * 2 + 10, charset), expected: 'invalid', technique: t },
  ];
  if (minLength > 0) cases.push({ label: 'empty', value: '', expected: 'invalid', technique: t });
  if (minLength > 1) {
    cases.push({ label: `too short (${Math.floor(minLength / 2)} chars)`, value: textOfLength(Math.floor(minLength / 2), charset), expected: 'invalid', technique: t });
  }
  return cases;
}

/**
 * Inputs that commonly break forms. "expected" is the safe behaviour: the
 * field should reject or safely handle the value, never crash or execute it.
 */
export function edgeCases(): TestValue[] {
  const t: TechniqueId = 'error-guessing';
  const c = (label: string, value: string, expected: TestValue['expected'], why: string): TestValue => ({
    label, value, expected, technique: t, why,
  });
  return [
    c('empty', '', 'invalid', 'required-field validation'),
    c('only spaces', '     ', 'invalid', 'should be trimmed and treated as empty'),
    c('leading and trailing spaces', '  value  ', 'valid', 'should be trimmed'),
    c('special characters', "!@#$%^&*()_+-=[]{};':\",./<>?\\|`~", 'valid', 'escaping and encoding'),
    c('accents and non-Latin', 'Zoë Ñúñez 李小龍 Müller', 'valid', 'Unicode handling'),
    c('emoji', 'Test 😀👍🏽🇲🇾', 'valid', 'multi-byte characters and length counting'),
    c('right-to-left text', 'مرحبا بالعالم', 'valid', 'RTL rendering'),
    c('HTML/script tag', '<script>alert(1)</script>', 'invalid', 'must not run as code (XSS)'),
    c('HTML image injection', '<img src=x onerror=alert(1)>', 'invalid', 'must not render as HTML (XSS)'),
    c('SQL quote', "O'Brien", 'valid', 'apostrophes in names must save correctly'),
    c('SQL injection', "' OR '1'='1' --", 'invalid', 'must not change the query'),
    c('very long (10,000 chars)', textOfLength(10_000), 'invalid', 'missing length limit'),
    c('zero', '0', 'valid', 'falsy value handling'),
    c('negative number', '-1', 'invalid', 'sign handling'),
    c('huge number', '99999999999999999999', 'invalid', 'overflow'),
    c('scientific notation', '1e5', 'invalid', 'number parsing'),
    c('line break', 'line one\nline two', 'valid', 'newlines in single-line fields'),
    c('null-like text', 'null', 'valid', 'the literal word null'),
    c('path traversal', '../../etc/passwd', 'invalid', 'must not reach the file system'),
  ];
}

/** Picks sensible test values from what a field declares about itself. */
export interface FieldConstraints {
  type?: string;
  minLength?: number;
  maxLength?: number;
  min?: string;
  max?: string;
  step?: string;
  pattern?: string;
  required?: boolean;
}

export function suggestCases(c: FieldConstraints, mode: BvaMode = '2-value'): TestValue[] {
  const type = (c.type ?? 'text').toLowerCase();
  const out: TestValue[] = [];
  if ((type === 'number' || type === 'range') && c.min !== undefined && c.max !== undefined) {
    const range = { min: Number(c.min), max: Number(c.max), step: c.step && c.step !== 'any' ? Number(c.step) : 1, mode };
    out.push(...numberBoundaries(range), ...numberPartitions(range));
  } else if (type === 'date' && c.min && c.max) {
    out.push(...dateBoundaries({ min: c.min, max: c.max, mode }));
  }
  if (c.maxLength !== undefined && c.maxLength >= 0) {
    const charset = type === 'email' ? 'email' : type === 'tel' || type === 'number' ? 'digits' : 'text';
    const range = { minLength: c.minLength ?? 0, maxLength: c.maxLength, mode, charset } as const;
    out.push(...lengthBoundaries(range), ...lengthPartitions(range));
  }
  return out;
}
