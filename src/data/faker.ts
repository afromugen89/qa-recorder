import { allFakers, type Faker } from '@faker-js/faker';

/** Options a QA can set for a generator. Each catalog entry declares which ones it reads. */
export interface GeneratorOptions {
  min?: number;
  max?: number;
  length?: number;
  precision?: number;
  /** Regular expression for the `pattern` type, e.g. `[A-Z]{3}-\d{4}`. */
  pattern?: string;
  /** Faker template for the `template` type, e.g. `{{person.firstName}}.qa@test.com`. `{i}` is the loop iteration. */
  template?: string;
  /** Any Faker method, e.g. `vehicle.vin`, for the `custom` type. */
  path?: string;
  /** JSON arguments for the `custom` type, e.g. `{"min": 1}` or `[5]`. */
  args?: string;
}

/** What to generate: a catalog type plus its options and locale. */
export interface GeneratorSpec {
  type: string;
  locale?: string;
  options?: GeneratorOptions;
}

type OptionName = keyof GeneratorOptions;

interface CatalogEntry {
  id: string;
  label: string;
  group: string;
  options?: OptionName[];
  generate: (f: Faker, o: GeneratorOptions, ctx: { iteration: number }) => string;
}

const num = (value: number | undefined, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const range = (o: GeneratorOptions, min: number, max: number) => {
  const lo = num(o.min, min);
  const hi = num(o.max, max);
  return lo <= hi ? { min: lo, max: hi } : { min: hi, max: lo };
};

/** Faker modules a `custom` path may call into. */
const CUSTOM_MODULES = new Set([
  'airline', 'animal', 'book', 'color', 'commerce', 'company', 'database', 'datatype', 'date', 'finance',
  'food', 'git', 'hacker', 'helpers', 'image', 'internet', 'location', 'lorem', 'music', 'number',
  'person', 'phone', 'science', 'string', 'system', 'vehicle', 'word',
]);

function stringify(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
}

function callCustom(f: Faker, path: string | undefined, args: string | undefined): string {
  const [moduleName, methodName, ...rest] = (path ?? '').trim().split('.');
  if (!moduleName || !methodName || rest.length || !CUSTOM_MODULES.has(moduleName)) {
    throw new Error(`Unknown Faker method "${path ?? ''}". Use module.method, e.g. vehicle.vin`);
  }
  const mod = (f as unknown as Record<string, Record<string, unknown>>)[moduleName];
  const method = Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(mod), methodName) ||
    Object.prototype.hasOwnProperty.call(mod, methodName)
    ? mod[methodName]
    : undefined;
  if (typeof method !== 'function' || methodName.startsWith('_') || methodName === 'constructor') {
    throw new Error(`Unknown Faker method "${path}"`);
  }
  let parsed: unknown[] = [];
  if (args && args.trim()) {
    try {
      const value: unknown = JSON.parse(args);
      parsed = Array.isArray(value) ? value : [value];
    } catch {
      throw new Error(`Arguments for ${path} must be JSON, e.g. {"min": 1} or [5]`);
    }
  }
  return stringify((method as (...a: unknown[]) => unknown).apply(mod, parsed));
}

export const CATALOG: CatalogEntry[] = [
  // Person
  { id: 'fullName', label: 'Full name', group: 'Person', generate: (f) => f.person.fullName() },
  { id: 'firstName', label: 'First name', group: 'Person', generate: (f) => f.person.firstName() },
  { id: 'lastName', label: 'Last name', group: 'Person', generate: (f) => f.person.lastName() },
  { id: 'jobTitle', label: 'Job title', group: 'Person', generate: (f) => f.person.jobTitle() },
  { id: 'gender', label: 'Gender', group: 'Person', generate: (f) => f.person.sex() },
  { id: 'birthdate', label: 'Birth date (YYYY-MM-DD)', group: 'Person', options: ['min', 'max'],
    generate: (f, o) => f.date.birthdate({ mode: 'age', ...range(o, 18, 80) }).toISOString().slice(0, 10) },

  // Internet
  { id: 'email', label: 'Email', group: 'Internet', generate: (f) => f.internet.email().toLowerCase() },
  { id: 'safeEmail', label: 'Email (example.com, never delivered)', group: 'Internet',
    generate: (f) => f.internet.exampleEmail().toLowerCase() },
  { id: 'username', label: 'Username', group: 'Internet', generate: (f) => f.internet.username() },
  { id: 'password', label: 'Password', group: 'Internet', options: ['length'],
    generate: (f, o) => f.internet.password({ length: num(o.length, 12), memorable: false }) },
  { id: 'url', label: 'URL', group: 'Internet', generate: (f) => f.internet.url() },
  { id: 'ipv4', label: 'IPv4 address', group: 'Internet', generate: (f) => f.internet.ipv4() },

  // Contact and address
  { id: 'phone', label: 'Phone number', group: 'Address', generate: (f) => f.phone.number() },
  { id: 'streetAddress', label: 'Street address', group: 'Address', generate: (f) => f.location.streetAddress() },
  { id: 'city', label: 'City', group: 'Address', generate: (f) => f.location.city() },
  { id: 'state', label: 'State', group: 'Address', generate: (f) => f.location.state() },
  { id: 'zipCode', label: 'Postcode', group: 'Address', generate: (f) => f.location.zipCode() },
  { id: 'country', label: 'Country', group: 'Address', generate: (f) => f.location.country() },
  { id: 'countryCode', label: 'Country code', group: 'Address', generate: (f) => f.location.countryCode() },

  // Business
  { id: 'company', label: 'Company name', group: 'Business', generate: (f) => f.company.name() },
  { id: 'productName', label: 'Product name', group: 'Business', generate: (f) => f.commerce.productName() },
  { id: 'price', label: 'Price', group: 'Business', options: ['min', 'max'],
    generate: (f, o) => f.commerce.price({ ...range(o, 1, 1000), dec: 2 }) },
  { id: 'department', label: 'Department', group: 'Business', generate: (f) => f.commerce.department() },

  // Numbers
  { id: 'integer', label: 'Whole number', group: 'Numbers', options: ['min', 'max'],
    generate: (f, o) => String(f.number.int(range(o, 0, 1000))) },
  { id: 'decimal', label: 'Decimal number', group: 'Numbers', options: ['min', 'max', 'precision'],
    generate: (f, o) => {
      const places = Math.max(0, Math.min(10, num(o.precision, 2)));
      return f.number.float({ ...range(o, 0, 1000), fractionDigits: places }).toFixed(places);
    } },
  { id: 'digits', label: 'Digits (fixed length)', group: 'Numbers', options: ['length'],
    generate: (f, o) => f.string.numeric({ length: num(o.length, 6), allowLeadingZeros: true }) },

  // Dates
  { id: 'pastDate', label: 'Past date (YYYY-MM-DD)', group: 'Dates',
    generate: (f) => f.date.past().toISOString().slice(0, 10) },
  { id: 'futureDate', label: 'Future date (YYYY-MM-DD)', group: 'Dates',
    generate: (f) => f.date.future().toISOString().slice(0, 10) },
  { id: 'time', label: 'Time (HH:MM)', group: 'Dates', generate: (f) => f.date.anytime().toISOString().slice(11, 16) },

  // Finance (test values only: card numbers pass Luhn checks but are not real)
  { id: 'creditCard', label: 'Card number (test)', group: 'Finance', generate: (f) => f.finance.creditCardNumber() },
  { id: 'cvv', label: 'Card CVV', group: 'Finance', generate: (f) => f.finance.creditCardCVV() },
  { id: 'iban', label: 'IBAN', group: 'Finance', generate: (f) => f.finance.iban() },
  { id: 'currencyCode', label: 'Currency code', group: 'Finance', generate: (f) => f.finance.currencyCode() },

  // Text
  { id: 'word', label: 'Word', group: 'Text', generate: (f) => f.lorem.word() },
  { id: 'sentence', label: 'Sentence', group: 'Text', generate: (f) => f.lorem.sentence() },
  { id: 'paragraph', label: 'Paragraph', group: 'Text', generate: (f) => f.lorem.paragraph() },
  { id: 'alphanumeric', label: 'Letters and digits (fixed length)', group: 'Text', options: ['length'],
    generate: (f, o) => f.string.alphanumeric(num(o.length, 10)) },
  { id: 'uuid', label: 'UUID', group: 'Text', generate: (f) => f.string.uuid() },

  // Advanced
  { id: 'pattern', label: 'Matches a pattern (regex)', group: 'Advanced', options: ['pattern'],
    generate: (f, o) => {
      if (!o.pattern) throw new Error('Enter a pattern, e.g. [A-Z]{3}-[0-9]{4}');
      return f.helpers.fromRegExp(o.pattern);
    } },
  { id: 'template', label: 'Template', group: 'Advanced', options: ['template'],
    generate: (f, o, ctx) => {
      if (!o.template) throw new Error('Enter a template, e.g. {{person.firstName}}.qa+{i}@test.com');
      const withIteration = o.template.replace(/\{i\}/g, String(ctx.iteration));
      return withIteration.includes('{{') ? f.helpers.fake(withIteration) : withIteration;
    } },
  { id: 'custom', label: 'Any Faker method', group: 'Advanced', options: ['path', 'args'],
    generate: (f, o) => callCustom(f, o.path, o.args) },
];

const BY_ID = new Map(CATALOG.map((entry) => [entry.id, entry]));

/** Locales QA is most likely to need, listed first in the panel. */
const PREFERRED_LOCALES = ['en_US', 'en_GB', 'en_AU', 'en_IN', 'id_ID', 'zh_CN', 'ja', 'ko', 'de', 'fr', 'es', 'vi', 'th'];

export function listLocales(): string[] {
  const all = Object.keys(allFakers).filter((l) => l !== 'base' && !l.startsWith('en_BORK') && !l.endsWith('_ocker'));
  return [...PREFERRED_LOCALES.filter((l) => all.includes(l)), ...all.filter((l) => !PREFERRED_LOCALES.includes(l)).sort()];
}

/** The catalog without the generator functions, for the browser panel. */
export function describeCatalog() {
  return CATALOG.map(({ id, label, group, options }) => ({ id, label, group, options: options ?? [] }));
}

/**
 * Generates Faker data. Seeded, so a session's data can be reproduced:
 * the same seed and the same sequence of requests give the same values.
 */
export class DataGenerator {
  readonly seed: number;
  private readonly fakers = new Map<string, Faker>();

  constructor(seed = Math.floor(Math.random() * 2 ** 31)) {
    this.seed = seed;
  }

  private fakerFor(locale = 'en_US'): Faker {
    let f = this.fakers.get(locale);
    if (!f) {
      const base = (allFakers as Record<string, Faker>)[locale];
      if (!base) throw new Error(`Unknown locale "${locale}"`);
      f = base;
      f.seed(this.seed);
      this.fakers.set(locale, f);
    }
    return f;
  }

  generate(spec: GeneratorSpec, iteration = 1): string {
    const entry = BY_ID.get(spec.type);
    if (!entry) throw new Error(`Unknown data type "${spec.type}"`);
    return entry.generate(this.fakerFor(spec.locale), spec.options ?? {}, { iteration });
  }

  generateMany(spec: GeneratorSpec, count: number): string[] {
    return Array.from({ length: Math.max(1, Math.min(count, 1000)) }, (_, i) => this.generate(spec, i + 1));
  }

  label(spec: GeneratorSpec): string {
    const entry = BY_ID.get(spec.type);
    if (!entry) return spec.type;
    if (spec.type === 'custom') return `Faker ${spec.options?.path ?? ''}`.trim();
    if (spec.type === 'template') return `Template ${spec.options?.template ?? ''}`.trim();
    if (spec.type === 'pattern') return `Pattern ${spec.options?.pattern ?? ''}`.trim();
    return entry.label;
  }
}
