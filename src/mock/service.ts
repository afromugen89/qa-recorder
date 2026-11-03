import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserContext, Request, Route } from 'playwright';
import {
  applyFieldEdits, applyHeaderEdits, newRuleId, ruleMatches, validateRule, type MockRule,
} from './rules.js';

/** What happened to one intercepted call; stored on its network event. */
export interface AppliedMock {
  ruleId: string;
  rule: string;
  mode: 'request-only' | 'modify' | 'replace' | 'fail';
  changes: string[];
}

/** A recent API call with full headers and body, for "Mock this". */
export interface RecentCall {
  seq: number;
  method: string;
  url: string;
  status?: number;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  mocked?: string;
}

export interface MockHost {
  apiResourceTypes: string[];
  recentCalls(): RecentCall[];
  /** Push the current state to every open panel. */
  broadcast(state: unknown): void;
  log(message: string): void;
}

const DROP_ON_FULFIL = new Set(['content-length', 'content-encoding', 'transfer-encoding']);
const FAILURES = new Set(['failed', 'timedout', 'connectionrefused', 'internetdisconnected', 'aborted', 'connectionreset', 'namenotresolved']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Intercepts API calls in the browser and applies the QA's mock rules:
 * change the request before it is sent, and change (or replace) the response.
 * Rules are saved to a JSON file so a team can share them.
 */
export class MockService {
  rules: MockRule[] = [];
  private readonly applied = new WeakMap<Request, AppliedMock>();
  private routed = false;
  private readonly handler = (route: Route) => this.onRoute(route);

  constructor(
    private readonly context: BrowserContext,
    private readonly path: string,
    private readonly host: MockHost,
  ) {
    this.rules = this.load();
  }

  /** The mock applied to a request, if any. */
  appliedTo(request: Request): AppliedMock | undefined {
    return this.applied.get(request);
  }

  activeCount(): number {
    return this.rules.filter((r) => r.enabled).length;
  }

  async start(): Promise<void> {
    await this.sync();
  }

  // ---------- persistence ----------

  private load(): MockRule[] {
    if (!existsSync(this.path)) return [];
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8')) as { rules?: MockRule[] };
      return Array.isArray(data.rules) ? data.rules.map((r) => ({ ...r, hits: 0 })) : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const rules = this.rules.map(({ hits: _hits, ...rule }) => rule);
    writeFileSync(this.path, JSON.stringify({ version: 1, rules }, null, 2));
  }

  /** Route only while a rule is on, so normal browsing isn't slowed down. */
  private async sync(): Promise<void> {
    const want = this.activeCount() > 0;
    if (want && !this.routed) {
      await this.context.route('**/*', this.handler);
      this.routed = true;
    } else if (!want && this.routed) {
      await this.context.unroute('**/*', this.handler);
      this.routed = false;
    }
  }

  private async changed(): Promise<void> {
    this.save();
    await this.sync();
    this.host.broadcast(this.state());
  }

  // ---------- rule management ----------

  state() {
    return {
      rules: this.rules,
      active: this.activeCount(),
      recent: this.host.recentCalls().map(({ seq, method, url, status, mocked }) => ({ seq, method, url, status, mocked })),
      path: this.path,
    };
  }

  async upsert(input: Partial<MockRule>): Promise<MockRule> {
    const rule: MockRule = {
      id: input.id || newRuleId(),
      name: input.name?.trim() || `${input.method ? `${input.method} ` : ''}${input.url ?? ''}`.trim(),
      enabled: input.enabled ?? true,
      method: input.method?.trim().toUpperCase() || undefined,
      url: input.url?.trim() ?? '',
      request: clean(input.request),
      response: input.response?.mode ? { ...clean(input.response)!, mode: input.response.mode } : undefined,
      delayMs: input.delayMs ? Math.max(0, Math.min(Number(input.delayMs), 120_000)) : undefined,
      once: input.once || undefined,
    };
    if (rule.response?.status !== undefined) rule.response.status = Number(rule.response.status);
    if (rule.response?.mode === 'fail' && rule.response.failure && !FAILURES.has(rule.response.failure)) {
      throw new Error(`Failure must be one of ${[...FAILURES].join(', ')}`);
    }
    validateRule(rule);
    const index = this.rules.findIndex((r) => r.id === rule.id);
    if (index >= 0) this.rules[index] = { ...rule, hits: this.rules[index].hits };
    else this.rules.push({ ...rule, hits: 0 });
    await this.changed();
    return rule;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) throw new Error('No such mock rule');
    rule.enabled = enabled;
    await this.changed();
  }

  async remove(id: string): Promise<void> {
    this.rules = this.rules.filter((r) => r.id !== id);
    await this.changed();
  }

  /** A draft rule that reproduces a recorded call, ready to edit. */
  draftFromCall(seq: number): Partial<MockRule> {
    const call = this.host.recentCalls().find((c) => c.seq === seq);
    if (!call) throw new Error('That call is no longer in the recent list');
    let path = call.url;
    try {
      path = new URL(call.url).pathname;
    } catch {
      /* keep full URL */
    }
    return {
      name: `${call.method} ${path}`,
      method: call.method,
      url: path,
      enabled: true,
      response: {
        mode: 'modify',
        status: call.status,
        headers: '',
        body: call.responseBody ?? '',
        fields: '',
      },
      request: { headers: '', body: '', fields: '' },
    };
  }

  async handle(command: { cmd: string; [key: string]: unknown }): Promise<unknown> {
    try {
      switch (command.cmd) {
        case 'mockState':
          return { ok: true, result: this.state() };
        case 'mockSave':
          await this.upsert(command.rule as Partial<MockRule>);
          return { ok: true, result: this.state() };
        case 'mockToggle':
          await this.setEnabled(String(command.id), Boolean(command.enabled));
          return { ok: true, result: this.state() };
        case 'mockDelete':
          await this.remove(String(command.id));
          return { ok: true, result: this.state() };
        case 'mockFromCall':
          return { ok: true, result: this.draftFromCall(Number(command.seq)) };
        default:
          return { ok: false, error: `Unknown command ${command.cmd}` };
      }
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  // ---------- interception ----------

  private async onRoute(route: Route): Promise<void> {
    const request = route.request();
    if (!this.host.apiResourceTypes.includes(request.resourceType())) return route.fallback();
    const rule = this.rules.find((r) => ruleMatches(r, request.method(), request.url()));
    if (!rule) return route.fallback();

    try {
      await this.apply(route, request, rule);
    } catch (error) {
      this.host.log(`Mock "${rule.name}" failed: ${(error as Error).message}`);
      await route.fallback().catch(() => undefined);
      return;
    }

    rule.hits = (rule.hits ?? 0) + 1;
    if (rule.once) {
      rule.enabled = false;
      await this.changed();
    } else {
      this.host.broadcast(this.state());
    }
  }

  private async apply(route: Route, request: Request, rule: MockRule): Promise<void> {
    const changes: string[] = [];

    // Before it is sent: headers and body.
    let headers = await request.allHeaders();
    let postData = request.postData() ?? undefined;
    if (rule.request) {
      const h = applyHeaderEdits(headers, rule.request.headers);
      headers = h.headers;
      changes.push(...h.changes.map((c) => `request ${c}`));
      if (rule.request.body) {
        postData = rule.request.body;
        changes.push('request body replaced');
      }
      if (rule.request.fields?.trim()) {
        const f = applyFieldEdits(postData ?? '', rule.request.fields);
        postData = f.body;
        changes.push(...f.changes.map((c) => `request ${c}`));
      }
    }
    // Headers the browser manages itself can't be overridden.
    for (const name of Object.keys(headers)) if (name.startsWith(':')) delete headers[name];

    if (rule.delayMs) {
      changes.push(`delayed ${rule.delayMs} ms`);
      await sleep(rule.delayMs);
    }

    const response = rule.response;
    const record = (mode: AppliedMock['mode']) =>
      this.applied.set(request, { ruleId: rule.id, rule: rule.name, mode, changes });

    if (!response) {
      record('request-only');
      await route.continue({ headers, postData });
      return;
    }

    if (response.mode === 'fail') {
      const failure = response.failure || 'failed';
      changes.push(`network failure (${failure})`);
      record('fail');
      await route.abort(failure);
      return;
    }

    let status: number;
    let responseHeaders: Record<string, string>;
    let body: string;
    if (response.mode === 'replace') {
      status = response.status ?? 200;
      responseHeaders = { 'content-type': 'application/json' };
      const origin = headers.origin;
      if (origin) {
        responseHeaders['access-control-allow-origin'] = origin;
        responseHeaders['access-control-allow-credentials'] = 'true';
      }
      body = response.body ?? '';
      changes.push(`response replaced (server not called), status ${status}`);
    } else {
      const real = await route.fetch({ headers, postData });
      status = response.status ?? real.status();
      responseHeaders = {};
      for (const [k, v] of Object.entries(real.headers())) if (!DROP_ON_FULFIL.has(k.toLowerCase())) responseHeaders[k] = v;
      const realBody = await real.text();
      body = response.body ? response.body : realBody;
      if (status !== real.status()) changes.push(`status ${real.status()} → ${status}`);
      if (response.body) changes.push('response body replaced');
    }

    const h = applyHeaderEdits(responseHeaders, response.headers);
    responseHeaders = h.headers;
    changes.push(...h.changes.map((c) => `response ${c}`));
    if (response.fields?.trim()) {
      const f = applyFieldEdits(body, response.fields);
      body = f.body;
      changes.push(...f.changes.map((c) => `response ${c}`));
    }

    record(response.mode);
    await route.fulfill({ status, headers: responseHeaders, body });
  }
}

function clean<T extends object>(edits: T | undefined): T | undefined {
  if (!edits) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(edits)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = typeof v === 'string' ? v : v;
  }
  return Object.keys(out).length ? (out as T) : undefined;
}
