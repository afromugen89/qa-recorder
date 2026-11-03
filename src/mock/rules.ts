/**
 * API mock rules: which calls to intercept and how to change them.
 * Pure functions, no Playwright, so they are easy to test.
 */

export interface RequestEdits {
  /** One per line: `Name: value` sets a header, `-Name` removes it. */
  headers?: string;
  /** Replace the whole request body with this text. */
  body?: string;
  /** One per line: `path.to.field = value` (JSON value), `-path` removes. Applied to a JSON body. */
  fields?: string;
}

export interface ResponseEdits {
  /**
   * modify: call the real server, then change its response.
   * replace: don't call the server; answer with status, headers and body below.
   * fail: simulate a network failure.
   */
  mode: 'modify' | 'replace' | 'fail';
  status?: number;
  headers?: string;
  body?: string;
  fields?: string;
  /** For `fail`: failed, timedout, connectionrefused, internetdisconnected, aborted. */
  failure?: string;
}

export interface MockRule {
  id: string;
  name: string;
  enabled: boolean;
  /** GET, POST… or empty for any. */
  method?: string;
  /**
   * Which URLs. Plain text matches anywhere in the URL, `*` is a wildcard,
   * and `/regex/` is a regular expression.
   */
  url: string;
  /** Edits before the request is sent. */
  request?: RequestEdits;
  /** Edits to the response. Omit to leave the response alone. */
  response?: ResponseEdits;
  /** Wait this long before answering (simulate a slow API). */
  delayMs?: number;
  /** Turn the rule off after it has been applied once. */
  once?: boolean;
  /** How many times it has been applied this session. */
  hits?: number;
}

export function urlMatcher(pattern: string): (url: string) => boolean {
  const p = pattern.trim();
  if (!p) return () => false;
  if (p.length > 2 && p.startsWith('/') && p.endsWith('/')) {
    let re: RegExp;
    try {
      re = new RegExp(p.slice(1, -1));
    } catch {
      throw new Error(`Invalid regular expression ${p}`);
    }
    return (url) => re.test(url);
  }
  if (!p.includes('*')) return (url) => url.includes(p);
  const re = new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return (url) => {
    if (re.test(url)) return true;
    try {
      const u = new URL(url);
      return re.test(`${u.pathname}${u.search}`) || re.test(u.pathname);
    } catch {
      return false;
    }
  };
}

export function ruleMatches(rule: MockRule, method: string, url: string): boolean {
  if (!rule.enabled) return false;
  if (rule.method && rule.method.toUpperCase() !== method.toUpperCase()) return false;
  try {
    return urlMatcher(rule.url)(url);
  } catch {
    return false;
  }
}

/** Throws a readable error if a rule can't work. */
export function validateRule(rule: MockRule): void {
  if (!rule.url?.trim()) throw new Error('Enter the URL to match, e.g. /api/orders');
  urlMatcher(rule.url);
  parseHeaderEdits(rule.request?.headers ?? '');
  parseHeaderEdits(rule.response?.headers ?? '');
  parseFieldEdits(rule.request?.fields ?? '');
  parseFieldEdits(rule.response?.fields ?? '');
  const status = rule.response?.status;
  if (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599)) {
    throw new Error('Status code must be between 100 and 599');
  }
  if (!rule.request && !rule.response && !rule.delayMs) throw new Error('The rule changes nothing. Add a request or response edit, or a delay.');
}

// ---------- headers ----------

export type HeaderEdit = { op: 'set'; name: string; value: string } | { op: 'remove'; name: string };

export function parseHeaderEdits(text: string): HeaderEdit[] {
  const edits: HeaderEdit[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('-')) {
      edits.push({ op: 'remove', name: line.slice(1).trim().toLowerCase() });
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) throw new Error(`Header line ${i + 1} should be "Name: value" or "-Name": ${line}`);
    edits.push({ op: 'set', name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() });
  }
  return edits;
}

export function applyHeaderEdits(headers: Record<string, string>, text: string | undefined): { headers: Record<string, string>; changes: string[] } {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  const changes: string[] = [];
  for (const edit of parseHeaderEdits(text ?? '')) {
    if (edit.op === 'remove') {
      if (edit.name in out) changes.push(`removed header ${edit.name}`);
      delete out[edit.name];
    } else {
      changes.push(`header ${edit.name}: ${edit.value}`);
      out[edit.name] = edit.value;
    }
  }
  return { headers: out, changes };
}

// ---------- JSON fields ----------

export type FieldEdit = { op: 'set'; path: (string | number)[]; value: unknown; raw: string } | { op: 'remove'; path: (string | number)[]; raw: string };

function parsePath(text: string): (string | number)[] {
  const path: (string | number)[] = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) path.push(m[2] !== undefined ? Number(m[2]) : m[1]);
  if (!path.length) throw new Error(`Empty field path "${text}"`);
  return path;
}

export function parseFieldEdits(text: string): FieldEdit[] {
  const edits: FieldEdit[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('-')) {
      edits.push({ op: 'remove', path: parsePath(line.slice(1).trim()), raw: line });
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) throw new Error(`Field line ${i + 1} should be "path = value" or "-path": ${line}`);
    const valueText = line.slice(eq + 1).trim();
    let value: unknown;
    try {
      value = JSON.parse(valueText);
    } catch {
      value = valueText; // unquoted text is a string
    }
    edits.push({ op: 'set', path: parsePath(line.slice(0, eq).trim()), value, raw: line });
  }
  return edits;
}

export function applyFieldEdits(body: string, text: string | undefined): { body: string; changes: string[] } {
  const edits = parseFieldEdits(text ?? '');
  if (!edits.length) return { body, changes: [] };
  let data: unknown;
  try {
    data = body.trim() ? JSON.parse(body) : {};
  } catch {
    throw new Error('Field edits need a JSON body');
  }
  const changes: string[] = [];
  for (const edit of edits) {
    let target = data as Record<string | number, unknown>;
    for (let i = 0; i < edit.path.length - 1; i++) {
      const key = edit.path[i];
      if (target[key] === undefined || target[key] === null || typeof target[key] !== 'object') {
        if (edit.op === 'remove') break;
        target[key] = typeof edit.path[i + 1] === 'number' ? [] : {};
      }
      target = target[key] as Record<string | number, unknown>;
    }
    const last = edit.path[edit.path.length - 1];
    if (edit.op === 'remove') {
      if (target && typeof target === 'object' && last in target) {
        if (Array.isArray(target) && typeof last === 'number') target.splice(last, 1);
        else delete target[last];
      }
    } else {
      target[last] = edit.value;
    }
    changes.push(edit.raw);
  }
  return { body: JSON.stringify(data), changes };
}

/** A new rule id. */
export function newRuleId(): string {
  return `m${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}
