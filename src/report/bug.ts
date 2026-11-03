import { ISTQB_TECHNIQUES, techniqueName, type TechniqueId } from '../data/techniques.js';
import type {
  ActionEvent, ConsoleEvent, LoopEvent, NavigationEvent, NetworkEvent, PageErrorEvent, SessionData, TimelineEvent,
} from '../recorder/types.js';

export type Severity = 'critical' | 'major' | 'minor' | 'trivial';
export type Priority = 'high' | 'medium' | 'low';

/** What the QA tells us about the bug. Everything is optional; gaps are filled from the recording. */
export interface BugInput {
  title?: string;
  expected?: string;
  actual?: string;
  severity?: Severity;
  priority?: Priority;
  /** Overrides the detected techniques. */
  techniques?: TechniqueId[];
  notes?: string;
  reporter?: string;
  /** Only include events after this seq (e.g. the previous bug). */
  fromSeq?: number;
  /** Only include events up to this seq. */
  toSeq?: number;
  /** Screenshot taken when the bug was marked, relative to the session folder. */
  screenshot?: string;
}

export interface ReportStep {
  number: number;
  text: string;
  /** Extra detail: test data technique, frame, shadow DOM. */
  detail?: string;
  /** ISTQB technique behind the value used, if any. */
  technique?: TechniqueId;
  expected?: 'valid' | 'invalid';
  screenshot?: string;
  url?: string;
  seqs: number[];
}

export interface ReportApiCall {
  step?: number;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  durationMs?: number;
  failure?: string;
  requestBody?: string;
  responseBody?: string;
  /** Name of the mock rule that changed this call, if any. */
  mock?: string;
}

export interface EndpointStats {
  endpoint: string;
  calls: number;
  errors: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
}

export interface BugReport {
  title: string;
  createdAt: string;
  severity?: Severity;
  priority?: Priority;
  reporter?: string;
  techniques: { id: TechniqueId; name: string; detected: boolean; reason?: string }[];
  environment: {
    url?: string;
    browser: string;
    userAgent?: string;
    recordedAt: string;
    dataSeed?: number;
  };
  steps: ReportStep[];
  expected?: string;
  actual: string;
  notes?: string;
  failedApiCalls: ReportApiCall[];
  slowApiCalls: ReportApiCall[];
  consoleErrors: { step?: number; level: string; text: string; location?: string }[];
  pageErrors: { step?: number; message: string; stack?: string }[];
  apiPerformance: EndpointStats[];
  slowThresholdMs: number;
  /** Mock rules that changed API calls in this report's range. */
  mocks: { rule: string; calls: number; changes: string[] }[];
  screenshot?: string;
  /** Every event in range, for the full timeline appendix. */
  timeline: TimelineEvent[];
}

const quote = (text: string, max = 60) => {
  const oneLine = text.replace(/\s+/g, ' ');
  return `"${oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine}"`;
};

function targetName(a: ActionEvent): string {
  const e = a.element;
  const name = e.accessibleName || e.text || e.name || e.id;
  const kind =
    e.role === 'button' ? 'button' :
    e.role === 'link' ? 'link' :
    e.role === 'checkbox' ? 'checkbox' :
    e.role === 'radio' ? 'option' :
    e.role === 'combobox' || e.role === 'listbox' ? 'dropdown' :
    e.tag === 'input' || e.tag === 'textarea' ? 'field' :
    e.role || e.tag;
  return name ? `${quote(name, 50)} ${kind}` : `${kind} (${a.locator.code})`;
}

/** Plain-English description of one recorded action. */
export function describeAction(a: ActionEvent): string {
  const target = targetName(a);
  switch (a.action) {
    case 'click': {
      const mods = a.modifiers?.length ? `${a.modifiers.join('+')}+` : '';
      return `${mods}${a.button === 'right' ? 'Right-click' : 'Click'} the ${target}`;
    }
    case 'dblclick':
      return `Double-click the ${target}`;
    case 'fill':
      if (a.value === '' ) return `Clear the ${target}`;
      if (a.sensitive && a.value === '********') return `Enter a password in the ${target}`;
      return `Enter ${quote(a.value ?? '')}${(a.value?.length ?? 0) > 20 ? ` (${a.value!.length} characters)` : ''} in the ${target}`;
    case 'check':
      return a.element.role === 'radio' ? `Select the ${target}` : `Tick the ${target}`;
    case 'uncheck':
      return `Untick the ${target}`;
    case 'select':
      return `Choose ${(a.labels ?? a.values ?? []).map((v) => quote(v)).join(', ')} in the ${target}`;
    case 'press':
      return `Press ${a.key} in the ${target}`;
    case 'setInputFiles':
      return `Upload ${(a.files ?? []).join(', ') || 'a file'} to the ${target}`;
  }
}

function actionDetail(a: ActionEvent): string | undefined {
  const parts: string[] = [];
  if (a.testData) {
    const t = a.testData.technique ? techniqueName(a.testData.technique) : a.testData.source;
    parts.push(`${t}: ${a.testData.label}${a.testData.expected ? `, expected ${a.testData.expected}` : ''}`);
  }
  if (a.framePath.length) parts.push(`inside iframe ${a.framePath.join(' > ')}`);
  if (a.element.inClosedShadowDom) parts.push('inside a closed shadow root');
  else if (a.element.inShadowDom) parts.push('inside shadow DOM');
  return parts.length ? parts.join('; ') : undefined;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

/** Groups URLs like /api/orders/123 and /api/orders/456 under /api/orders/:id. */
export function endpointKey(method: string, url: string): string {
  let path = url;
  try {
    const u = new URL(url);
    path = `${u.host}${u.pathname}`;
  } catch {
    /* keep as is */
  }
  path = path
    .split('/')
    .map((seg) =>
      /^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^[0-9a-f]{16,}$/i.test(seg)
        ? ':id'
        : seg,
    )
    .join('/');
  return `${method} ${path}`;
}

export function apiPerformance(calls: NetworkEvent[]): EndpointStats[] {
  const groups = new Map<string, NetworkEvent[]>();
  for (const call of calls) {
    const key = endpointKey(call.method, call.url);
    groups.set(key, [...(groups.get(key) ?? []), call]);
  }
  return [...groups.entries()]
    .map(([endpoint, list]) => {
      const times = list.map((c) => c.durationMs).filter((d): d is number => d !== undefined).sort((a, b) => a - b);
      return {
        endpoint,
        calls: list.length,
        errors: list.filter((c) => c.isError).length,
        avgMs: times.length ? Math.round(times.reduce((s, t) => s + t, 0) / times.length) : 0,
        p95Ms: percentile(times, 95),
        maxMs: times.at(-1) ?? 0,
      };
    })
    .sort((a, b) => b.errors - a.errors || b.maxMs - a.maxMs);
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/** Picks the ISTQB techniques that the steps' test data shows were used. */
export function detectTechniques(actions: ActionEvent[]): BugReport['techniques'] {
  const found = new Map<TechniqueId, string[]>();
  for (const a of actions) {
    const t = a.testData?.technique;
    if (!t) continue;
    found.set(t, [...(found.get(t) ?? []), a.testData!.label]);
  }
  if (actions.some((a) => a.loop)) {
    // A captured flow replayed with varied data follows a use case end to end.
    found.set('use-case-testing', [...(found.get('use-case-testing') ?? []), 'looper replayed a captured flow']);
  }
  const out = [...found.entries()].map(([id, labels]) => ({
    id,
    name: techniqueName(id),
    detected: true,
    reason: `${[...new Set(labels)].slice(0, 3).join(', ')}${labels.length > 3 ? '…' : ''}`,
  }));
  if (!out.length) {
    out.push({ id: 'exploratory-testing', name: techniqueName('exploratory-testing'), detected: true, reason: 'no generated test data was used' });
  }
  return out;
}

/** Builds the steps list. Looper iterations are folded into one step per run. */
function buildSteps(events: TimelineEvent[], startUrl?: string): { steps: ReportStep[]; stepOfSeq: Map<number, number> } {
  const steps: ReportStep[] = [];
  const stepOfSeq = new Map<number, number>();
  let lastUrl: string | undefined;
  const opensPage = events.find((e) => e.type === 'navigation' || e.type === 'action');
  if (startUrl && opensPage?.type !== 'navigation') {
    // The report starts mid-session: say where the tester was.
    steps.push({ number: 1, text: `Start on ${startUrl}`, url: startUrl, seqs: [] });
    lastUrl = startUrl;
  }
  const loops = new Map<number, { step: ReportStep; iterations: Set<number>; actions: number }>();
  const loopEnds = new Map<number, LoopEvent>();
  for (const e of events) if (e.type === 'loop' && e.phase === 'run-end' && e.runId) loopEnds.set(e.runId, e);

  for (const e of events) {
    if (e.type === 'navigation' && e.pageId === 1 && !e.newPage) {
      if (e.url !== lastUrl && e.url !== 'about:blank') {
        const step: ReportStep = { number: steps.length + 1, text: `Open ${e.url}`, url: e.url, seqs: [e.seq] };
        steps.push(step);
        stepOfSeq.set(e.seq, step.number);
        lastUrl = e.url;
      }
      continue;
    }
    if (e.type === 'navigation' && e.newPage) {
      const step: ReportStep = { number: steps.length + 1, text: `A new tab opens: ${e.url}`, seqs: [e.seq] };
      steps.push(step);
      stepOfSeq.set(e.seq, step.number);
      continue;
    }
    if (e.type !== 'action') continue;
    if (e.loop) {
      let group = loops.get(e.loop.runId);
      if (!group) {
        const end = loopEnds.get(e.loop.runId);
        const step: ReportStep = {
          number: steps.length + 1,
          text: '',
          detail: end ? `${end.passed ?? 0} of ${end.total ?? 0} iterations passed${end.stopped ? ' (stopped early)' : ''}` : undefined,
          technique: 'use-case-testing',
          seqs: [],
        };
        steps.push(step);
        group = { step, iterations: new Set(), actions: 0 };
        loops.set(e.loop.runId, group);
      }
      group.iterations.add(e.loop.iteration);
      group.actions++;
      group.step.seqs.push(e.seq);
      group.step.text = `Repeat the captured flow ${group.iterations.size} times with generated data (looper)`;
      if (e.screenshot) group.step.screenshot = e.screenshot;
      stepOfSeq.set(e.seq, group.step.number);
      continue;
    }
    const step: ReportStep = {
      number: steps.length + 1,
      text: describeAction(e),
      detail: actionDetail(e),
      technique: e.testData?.technique,
      expected: e.testData?.expected,
      screenshot: e.screenshot,
      seqs: [e.seq],
    };
    steps.push(step);
    stepOfSeq.set(e.seq, step.number);
  }
  return { steps, stepOfSeq };
}

/** The step during or just before an event. */
function stepAt(seqOrTime: { seq: number; timestamp: number; triggeredBy?: number }, events: TimelineEvent[], stepOfSeq: Map<number, number>) {
  if (seqOrTime.triggeredBy !== undefined && stepOfSeq.has(seqOrTime.triggeredBy)) return stepOfSeq.get(seqOrTime.triggeredBy);
  let found: number | undefined;
  for (const e of events) {
    if (e.timestamp > seqOrTime.timestamp) break;
    const n = stepOfSeq.get(e.seq);
    if (n !== undefined) found = n;
  }
  return found;
}

function suggestTitle(failed: ReportApiCall[], pageErrors: PageErrorEvent[], consoleErrors: ConsoleEvent[], slow: ReportApiCall[], steps: ReportStep[]): string {
  const stepText = (n?: number) => {
    const s = steps.find((x) => x.number === n);
    if (!s) return '';
    const t = s.text.replace(/^Click the /, 'clicking ').replace(/^Enter /, 'entering ').replace(/^Open /, 'opening ');
    return ` after ${t.charAt(0).toLowerCase()}${t.slice(1)}`;
  };
  const serverError = failed.find((c) => (c.status ?? 0) >= 500) ?? failed.find((c) => c.failure) ?? failed[0];
  if (serverError) {
    const what = serverError.failure ? `fails (${serverError.failure})` : `returns ${serverError.status}`;
    return `${serverError.method} ${shortUrl(serverError.url)} ${what}${stepText(serverError.step)}`;
  }
  if (pageErrors.length) return `Uncaught error: ${pageErrors[0].message.slice(0, 80)}`;
  if (consoleErrors.length) return `Console error: ${consoleErrors[0].text.slice(0, 80)}`;
  if (slow.length) return `${slow[0].method} ${shortUrl(slow[0].url)} takes ${slow[0].durationMs} ms${stepText(slow[0].step)}`;
  return 'Untitled bug';
}

function suggestActual(failed: ReportApiCall[], pageErrors: { message: string }[], consoleErrors: { text: string }[], slow: ReportApiCall[], threshold: number): string {
  const lines: string[] = [];
  for (const c of failed.slice(0, 5)) {
    const body = c.responseBody ? `: ${c.responseBody.replace(/\s+/g, ' ').slice(0, 120)}` : '';
    lines.push(c.failure
      ? `${c.method} ${shortUrl(c.url)} failed (${c.failure})${c.step ? ` at step ${c.step}` : ''}.`
      : `${c.method} ${shortUrl(c.url)} returned ${c.status} ${c.statusText ?? ''}`.trim() + `${body}${c.step ? ` (step ${c.step})` : ''}.`);
  }
  for (const e of pageErrors.slice(0, 3)) lines.push(`Uncaught JavaScript error: ${e.message}`);
  for (const e of consoleErrors.slice(0, 3)) lines.push(`Console error: ${e.text.slice(0, 200)}`);
  for (const c of slow.slice(0, 3)) lines.push(`${c.method} ${shortUrl(c.url)} took ${c.durationMs} ms (threshold ${threshold} ms).`);
  return lines.length ? lines.join('\n') : 'Describe what happened.';
}

/** Builds a bug report from a recorded session. */
export function buildBugReport(session: SessionData, input: BugInput = {}): BugReport {
  const from = input.fromSeq ?? 0;
  const to = input.toSeq ?? Infinity;
  const events = session.events.filter((e) => e.seq > from && e.seq <= to);
  const before = session.events.filter((e): e is NavigationEvent => e.type === 'navigation' && e.pageId === 1 && e.seq <= from);
  const { steps, stepOfSeq } = buildSteps(events, before.at(-1)?.url);

  const network = events.filter((e): e is NetworkEvent => e.type === 'network');
  const toCall = (c: NetworkEvent): ReportApiCall => ({
    step: stepAt(c, events, stepOfSeq),
    method: c.method,
    url: c.url,
    status: c.status,
    statusText: c.statusText,
    durationMs: c.durationMs,
    failure: c.failure,
    requestBody: c.requestBody,
    responseBody: c.responseBody,
    ...(c.mock && { mock: c.mock.rule }),
  });
  const failedApiCalls = network.filter((c) => c.isError).map(toCall);
  const slowApiCalls = network.filter((c) => c.isSlow && !c.isError).map(toCall);
  const consoleEvents = events.filter((e): e is ConsoleEvent => e.type === 'console');
  const pageErrorEvents = events.filter((e): e is PageErrorEvent => e.type === 'pageerror');
  const consoleErrors = consoleEvents.map((e) => ({ step: stepAt(e, events, stepOfSeq), level: e.level, text: e.text, location: e.location }));
  const pageErrors = pageErrorEvents.map((e) => ({ step: stepAt(e, events, stepOfSeq), message: e.message, stack: e.stack }));
  const actions = events.filter((e): e is ActionEvent => e.type === 'action');

  const detected = detectTechniques(actions);
  const techniques = input.techniques?.length
    ? input.techniques
        .filter((id) => id in ISTQB_TECHNIQUES)
        .map((id) => {
          const auto = detected.find((d) => d.id === id);
          return { id, name: techniqueName(id), detected: Boolean(auto), reason: auto?.reason };
        })
    : detected;

  const errorConsole = consoleEvents.filter((e) => e.level === 'error');
  const firstNav = events.find((e): e is NavigationEvent => e.type === 'navigation' && e.pageId === 1);
  const startUrl = firstNav?.url ?? session.meta.startUrl;

  return {
    title: input.title?.trim() || suggestTitle(failedApiCalls, pageErrorEvents, errorConsole, slowApiCalls, steps),
    createdAt: new Date().toISOString(),
    severity: input.severity,
    priority: input.priority,
    reporter: input.reporter,
    techniques,
    environment: {
      url: startUrl,
      browser: session.meta.browser,
      userAgent: session.meta.userAgent,
      recordedAt: session.meta.startedAt,
      dataSeed: session.meta.dataSeed,
    },
    steps,
    expected: input.expected?.trim() || undefined,
    actual: input.actual?.trim() || suggestActual(failedApiCalls, pageErrorEvents, errorConsole, slowApiCalls, session.meta.slowThresholdMs),
    notes: input.notes?.trim() || undefined,
    failedApiCalls,
    slowApiCalls,
    consoleErrors,
    pageErrors,
    apiPerformance: apiPerformance(network),
    slowThresholdMs: session.meta.slowThresholdMs,
    mocks: summarizeMocks(network),
    screenshot: input.screenshot,
    timeline: events,
  };
}

function summarizeMocks(network: NetworkEvent[]): BugReport['mocks'] {
  const byRule = new Map<string, { rule: string; calls: number; changes: Set<string> }>();
  for (const c of network) {
    if (!c.mock) continue;
    const entry = byRule.get(c.mock.ruleId) ?? { rule: c.mock.rule, calls: 0, changes: new Set<string>() };
    entry.calls++;
    for (const change of c.mock.changes) entry.changes.add(change);
    byRule.set(c.mock.ruleId, entry);
  }
  return [...byRule.values()].map((m) => ({ rule: m.rule, calls: m.calls, changes: [...m.changes] }));
}

/** Draft values for the panel's bug form. */
export function bugDraft(session: SessionData, fromSeq = 0) {
  const report = buildBugReport(session, { fromSeq });
  return {
    title: report.title,
    actual: report.actual,
    techniques: report.techniques,
    steps: report.steps.length,
    failedApiCalls: report.failedApiCalls.length,
    slowApiCalls: report.slowApiCalls.length,
    consoleErrors: report.consoleErrors.filter((e) => e.level === 'error').length,
    pageErrors: report.pageErrors.length,
    mockedCalls: report.mocks.reduce((sum, m) => sum + m.calls, 0),
  };
}
