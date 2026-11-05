import { ISTQB_TECHNIQUES, techniqueName, type TechniqueId } from '../data/techniques.js';
import { a11ySummary, type A11yRule } from '../audit/a11y.js';
import { layoutSummary, type ViewportResult } from '../audit/layout.js';
import type {
  A11yEvent, ActionEvent, ConsoleEvent, LayoutEvent, LoopEvent, NavigationEvent, NetworkEvent, PageErrorEvent, SessionData,
  TimelineEvent, ViewportEvent,
} from '../recorder/types.js';

export type Severity = 'critical' | 'major' | 'minor' | 'trivial';
export type Priority = 'high' | 'medium' | 'low';

/** What the QA tells us about the bug. Everything is optional; gaps are filled from the recording. */
export interface BugInput {
  title?: string;
  expected?: string;
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
  /**
   * Steps to leave out, by `ReportStep.key`. Remaining steps are renumbered;
   * API calls and errors from a left-out step are listed under the step before it.
   */
  excludeSteps?: string[];
  /** Screenshots to leave out, by path relative to the session folder. */
  excludeScreenshots?: string[];
  /**
   * Optional API sections. Each one is included unless set to false:
   * failed calls, slow calls and the response times table.
   */
  sections?: Partial<Record<ApiSection, boolean>>;
  /** Failed or slow API calls to leave out, by `ReportApiCall.key`. */
  excludeApiCalls?: string[];
  /** Endpoints to leave out of the response times table, by `EndpointStats.endpoint`. */
  excludeEndpoints?: string[];
}

/** The API sections a QA can switch on or off. */
export type ApiSection = 'failedApiCalls' | 'slowApiCalls' | 'apiResponseTimes';
export const API_SECTIONS: ApiSection[] = ['failedApiCalls', 'slowApiCalls', 'apiResponseTimes'];

export interface ReportStep {
  number: number;
  /** Stable id for picking steps: the first recorded event's seq, or "start". */
  key: string;
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
  /** Stable id for picking calls: the recorded event's seq. */
  key: string;
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

/** One accessibility scan in the report's range. */
export interface ReportA11yScan {
  step?: number;
  url: string;
  /** e.g. "WCAG 2.2 AA". */
  standard: string;
  engine: string;
  summary: string;
  violations: A11yRule[];
  /** Rules a person still has to check. */
  needsReview: { id: string; help: string; nodeCount: number; wcag: string[] }[];
  passes: number;
  screenshot?: string;
}

/** One responsive layout check in the report's range. */
export interface ReportLayoutCheck {
  step?: number;
  url: string;
  summary: string;
  viewports: ViewportResult[];
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
    /** Playwright device the session was recorded as. */
    device?: string;
    /** Tab size: the recording's starting size, or the last size the QA resized it to. */
    viewport?: { width: number; height: number; label?: string };
  };
  steps: ReportStep[];
  expected?: string;
  notes?: string;
  failedApiCalls: ReportApiCall[];
  slowApiCalls: ReportApiCall[];
  consoleErrors: { step?: number; level: string; text: string; location?: string }[];
  pageErrors: { step?: number; message: string; stack?: string }[];
  apiPerformance: EndpointStats[];
  slowThresholdMs: number;
  /** Mock rules that changed API calls in this report's range. */
  mocks: { rule: string; calls: number; changes: string[] }[];
  /** Accessibility scans in this report's range. */
  accessibility: ReportA11yScan[];
  /** Responsive layout checks in this report's range. */
  layout: ReportLayoutCheck[];
  screenshot?: string;
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

/** Picks the ISTQB techniques that the steps' test data (and any checks run) show were used. */
export function detectTechniques(actions: ActionEvent[], checks: (A11yEvent | LayoutEvent)[] = []): BugReport['techniques'] {
  const found = new Map<TechniqueId, string[]>();
  const note = (id: TechniqueId, label: string) => found.set(id, [...(found.get(id) ?? []), label]);
  for (const c of checks) {
    if (c.type === 'a11y') note('checklist-based-testing', `${c.result.standard} checklist (${c.result.engine})`);
    else {
      const sized = c.result.viewports.filter((v) => !v.boundary);
      if (sized.length) note('checklist-based-testing', `responsive layout checklist at ${sized.map((v) => `${v.width}px`).join(', ')}`);
      const edges = c.result.viewports.filter((v) => v.boundary).map((v) => v.width);
      if (edges.length) note('boundary-value-analysis', `CSS breakpoint widths ${edges.join(', ')} px`);
    }
  }
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
    steps.push({ number: 1, key: 'start', text: `Start on ${startUrl}`, url: startUrl, seqs: [] });
    lastUrl = startUrl;
  }
  const loops = new Map<number, { step: ReportStep; iterations: Set<number>; actions: number }>();
  const loopEnds = new Map<number, LoopEvent>();
  for (const e of events) if (e.type === 'loop' && e.phase === 'run-end' && e.runId) loopEnds.set(e.runId, e);

  for (const e of events) {
    if (e.type === 'navigation' && e.pageId === 1 && !e.newPage) {
      if (e.url !== lastUrl && e.url !== 'about:blank') {
        const step: ReportStep = { number: steps.length + 1, key: String(e.seq), text: `Open ${e.url}`, url: e.url, seqs: [e.seq] };
        steps.push(step);
        stepOfSeq.set(e.seq, step.number);
        lastUrl = e.url;
      }
      continue;
    }
    if (e.type === 'a11y' || e.type === 'layout' || e.type === 'viewport') {
      const step: ReportStep = { number: steps.length + 1, key: String(e.seq), text: describeCheck(e), seqs: [e.seq] };
      if (e.type === 'a11y') {
        step.detail = a11ySummary(e.result);
        step.technique = 'checklist-based-testing';
      } else if (e.type === 'layout') {
        step.detail = layoutSummary(e.result);
        step.technique = e.result.viewports.some((v) => v.boundary) ? 'boundary-value-analysis' : 'checklist-based-testing';
      }
      steps.push(step);
      stepOfSeq.set(e.seq, step.number);
      continue;
    }
    if (e.type === 'navigation' && e.newPage) {
      const step: ReportStep = { number: steps.length + 1, key: String(e.seq), text: `A new tab opens: ${e.url}`, seqs: [e.seq] };
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
          key: String(e.seq),
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
      key: String(e.seq),
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

/**
 * Drops the steps the QA left out and renumbers the rest. Events that belonged
 * to a dropped step point at the kept step before it ("after step N").
 */
function selectSteps(
  steps: ReportStep[], stepOfSeq: Map<number, number>, exclude: string[] = [], dropShots: Set<string>,
): { steps: ReportStep[]; stepOfSeq: Map<number, number> } {
  const skip = new Set(exclude);
  const renumber = new Map<number, number>();
  const kept: ReportStep[] = [];
  for (const step of steps) {
    if (!skip.has(step.key)) {
      const { screenshot, ...rest } = step;
      kept.push({ ...rest, number: kept.length + 1, ...(screenshot && !dropShots.has(screenshot) && { screenshot }) });
    }
    if (kept.length) renumber.set(step.number, kept.length);
  }
  const remapped = new Map<number, number>();
  for (const [seq, n] of stepOfSeq) {
    const m = renumber.get(n);
    if (m !== undefined) remapped.set(seq, m);
  }
  return { steps: kept, stepOfSeq: remapped };
}

/** Plain-English step for a check or a resize. */
export function describeCheck(e: A11yEvent | LayoutEvent | ViewportEvent): string {
  switch (e.type) {
    case 'a11y':
      return `Run an accessibility check (${e.result.standard}) on ${shortUrl(e.url)}`;
    case 'layout': {
      const sizes = e.result.viewports.map((v) => (v.fresh ? `${v.width}×${v.height}` : 'the current tab'));
      return `Check the responsive layout of ${shortUrl(e.url)} at ${sizes.join(', ')}`;
    }
    case 'viewport':
      return e.reset
        ? `Resize the browser view back to ${e.width}×${e.height}`
        : `Resize the browser view to ${e.width}×${e.height}${e.label ? ` (${e.label})` : ''}`;
  }
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

function checkTitle(a11y: ReportA11yScan[], layout: ReportLayoutCheck[]): string | undefined {
  const scan = [...a11y].reverse().find((s) => s.violations.length);
  if (scan) {
    const worst = scan.violations[0];
    const more = scan.violations.length > 1 ? ` and ${scan.violations.length - 1} more ${scan.standard} issue${scan.violations.length > 2 ? 's' : ''}` : '';
    return `Accessibility: ${worst.help} (${worst.nodeCount} element${worst.nodeCount > 1 ? 's' : ''})${more} on ${shortUrl(scan.url)}`;
  }
  for (const check of [...layout].reverse()) {
    const v = check.viewports.find((x) => x.issues.some((i) => i.severity === 'error'));
    if (v) {
      const issue = v.issues.find((i) => i.severity === 'error')!;
      const what = issue.kind === 'horizontal-scroll' ? 'page scrolls sideways'
        : issue.kind === 'overlap' ? 'tap targets overlap'
        : issue.kind === 'zoom-disabled' ? 'pinch zoom is blocked'
        : issue.kind === 'meta-viewport' ? 'no viewport meta tag'
        : 'content sticks out of the screen';
      return `Layout at ${v.width}×${v.height}${v.device ? ` (${v.device})` : ''}: ${what} on ${shortUrl(check.url)}`;
    }
  }
  return undefined;
}

function suggestTitle(failed: ReportApiCall[], pageErrors: PageErrorEvent[], consoleErrors: ConsoleEvent[], slow: ReportApiCall[], steps: ReportStep[], checks?: string): string {
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
  // A check the QA ran on purpose matters more than background console noise.
  if (checks) return checks;
  if (consoleErrors.length) return `Console error: ${consoleErrors[0].text.slice(0, 80)}`;
  if (slow.length) return `${slow[0].method} ${shortUrl(slow[0].url)} takes ${slow[0].durationMs} ms${stepText(slow[0].step)}`;
  return 'Untitled bug';
}

/** Builds a bug report from a recorded session. */
export function buildBugReport(session: SessionData, input: BugInput = {}): BugReport {
  const from = input.fromSeq ?? 0;
  const to = input.toSeq ?? Infinity;
  const events = session.events.filter((e) => e.seq > from && e.seq <= to);
  const before = session.events.filter((e): e is NavigationEvent => e.type === 'navigation' && e.pageId === 1 && e.seq <= from);
  const dropShots = new Set(input.excludeScreenshots ?? []);
  const keepShot = (path?: string) => (path && !dropShots.has(path) ? path : undefined);
  const built = buildSteps(events, before.at(-1)?.url);
  const { steps, stepOfSeq } = selectSteps(built.steps, built.stepOfSeq, input.excludeSteps, dropShots);

  const network = events.filter((e): e is NetworkEvent => e.type === 'network');
  const toCall = (c: NetworkEvent): ReportApiCall => ({
    key: String(c.seq),
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
  const on = (section: ApiSection) => input.sections?.[section] !== false;
  const skipCalls = new Set(input.excludeApiCalls ?? []);
  const skipEndpoints = new Set(input.excludeEndpoints ?? []);
  const pickCalls = (section: ApiSection, list: NetworkEvent[]) =>
    on(section) ? list.map(toCall).filter((c) => !skipCalls.has(c.key)) : [];
  const failedApiCalls = pickCalls('failedApiCalls', network.filter((c) => c.isError));
  const slowApiCalls = pickCalls('slowApiCalls', network.filter((c) => c.isSlow && !c.isError));
  const responseTimes = on('apiResponseTimes') ? apiPerformance(network).filter((p) => !skipEndpoints.has(p.endpoint)) : [];
  const consoleEvents = events.filter((e): e is ConsoleEvent => e.type === 'console');
  const pageErrorEvents = events.filter((e): e is PageErrorEvent => e.type === 'pageerror');
  const consoleErrors = consoleEvents.map((e) => ({ step: stepAt(e, events, stepOfSeq), level: e.level, text: e.text, location: e.location }));
  const pageErrors = pageErrorEvents.map((e) => ({ step: stepAt(e, events, stepOfSeq), message: e.message, stack: e.stack }));
  const actions = events.filter((e): e is ActionEvent => e.type === 'action');

  const checkEvents = events.filter((e): e is A11yEvent | LayoutEvent => e.type === 'a11y' || e.type === 'layout');
  const accessibility: ReportA11yScan[] = checkEvents.filter((e): e is A11yEvent => e.type === 'a11y').map((e) => ({
    step: stepOfSeq.get(e.seq),
    url: e.url,
    standard: e.result.standard,
    engine: e.result.engine,
    summary: a11ySummary(e.result),
    violations: e.result.violations,
    needsReview: e.result.needsReview.map((r) => ({ id: r.id, help: r.help, nodeCount: r.nodeCount, wcag: r.wcag })),
    passes: e.result.passes,
    screenshot: keepShot(e.screenshot),
  }));
  const layout: ReportLayoutCheck[] = checkEvents.filter((e): e is LayoutEvent => e.type === 'layout').map((e) => ({
    step: stepOfSeq.get(e.seq),
    url: e.url,
    summary: layoutSummary(e.result),
    viewports: e.result.viewports.map(({ screenshot, ...v }) => ({ ...v, ...(keepShot(screenshot) && { screenshot }) })),
  }));
  const lastResize = session.events.filter((e): e is ViewportEvent => e.type === 'viewport' && e.seq <= to).at(-1);
  const viewport = lastResize && !lastResize.reset
    ? { width: lastResize.width, height: lastResize.height, ...(lastResize.label && { label: lastResize.label }) }
    : session.meta.viewport;

  const detected = detectTechniques(actions, checkEvents);
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
    title: input.title?.trim() || suggestTitle(failedApiCalls, pageErrorEvents, errorConsole, slowApiCalls, steps, checkTitle(accessibility, layout)),
    createdAt: new Date().toISOString(),
    severity: input.severity,
    priority: input.priority,
    reporter: input.reporter,
    techniques,
    environment: {
      url: startUrl,
      browser: session.meta.browser,
      userAgent: session.meta.userAgent,
      ...(session.meta.device && { device: session.meta.device }),
      ...(viewport && { viewport }),
    },
    steps,
    expected: input.expected?.trim() || undefined,
    notes: input.notes?.trim() || undefined,
    failedApiCalls,
    slowApiCalls,
    consoleErrors,
    pageErrors,
    apiPerformance: responseTimes,
    slowThresholdMs: session.meta.slowThresholdMs,
    mocks: summarizeMocks(network),
    accessibility,
    layout,
    screenshot: keepShot(input.screenshot),
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

/** A screenshot the QA can choose to keep in or leave out of a report. */
export interface ReportScreenshot {
  path: string;
  label: string;
  /** Key of the step it belongs to; it goes when that step is left out. */
  step?: string;
}

/** Every screenshot a report would include, in report order. */
export function reportScreenshots(report: BugReport): ReportScreenshot[] {
  const out: ReportScreenshot[] = [];
  for (const s of report.steps) if (s.screenshot) out.push({ path: s.screenshot, label: `After step ${s.number}: ${s.text}`, step: s.key });
  for (const a of report.accessibility) {
    if (a.screenshot) out.push({ path: a.screenshot, label: `Accessibility issues outlined${a.step ? ` (step ${a.step})` : ''}` });
  }
  for (const c of report.layout) {
    for (const v of c.viewports) {
      if (v.screenshot) out.push({ path: v.screenshot, label: `Layout at ${v.width}×${v.height}${v.device ? ` (${v.device})` : ''}` });
    }
  }
  return out;
}

/** Draft values for the panel's bug form. */
export function bugDraft(session: SessionData, fromSeq = 0) {
  const report = buildBugReport(session, { fromSeq });
  return {
    techniques: report.techniques,
    steps: report.steps.length,
    /** For the step and screenshot pickers. */
    stepList: report.steps.map((s) => ({ key: s.key, number: s.number, text: s.text, screenshot: s.screenshot })),
    screenshots: reportScreenshots(report),
    failedApiCalls: report.failedApiCalls.length,
    slowApiCalls: report.slowApiCalls.length,
    /** For the API pickers. */
    apiLists: {
      failedApiCalls: report.failedApiCalls.map((c) => ({ key: c.key, label: callLabel(c) })),
      slowApiCalls: report.slowApiCalls.map((c) => ({ key: c.key, label: callLabel(c) })),
      apiResponseTimes: report.apiPerformance.map((p) => ({
        key: p.endpoint,
        label: `${p.endpoint} · ${p.calls} call${p.calls > 1 ? 's' : ''}, avg ${p.avgMs} ms, max ${p.maxMs} ms${p.errors ? `, ${p.errors} failed` : ''}`,
      })),
    },
    consoleErrors: report.consoleErrors.filter((e) => e.level === 'error').length,
    pageErrors: report.pageErrors.length,
    mockedCalls: report.mocks.reduce((sum, m) => sum + m.calls, 0),
    a11yViolations: report.accessibility.reduce((sum, s) => sum + s.violations.length, 0),
    layoutIssues: report.layout.reduce((sum, c) => sum + c.viewports.reduce((n, v) => n + v.issues.length, 0), 0),
  };
}

function callLabel(c: ReportApiCall): string {
  const status = c.failure ? `failed (${c.failure})` : `${c.status ?? '?'}`;
  return `${c.step ? `Step ${c.step} · ` : ''}${c.method} ${shortUrl(c.url)} → ${status} · ${c.durationMs ?? '?'} ms`;
}
