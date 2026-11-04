import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chromium,
  devices,
  type Browser,
  type BrowserContextOptions,
  type BrowserContext,
  type Frame,
  type Page,
  type Request,
} from 'playwright';
import { AuditService } from '../audit/service.js';
import { DataService } from '../data/service.js';
import { MockService, type RecentCall } from '../mock/service.js';
import { bugDraft, type BugInput } from '../report/bug.js';
import { writeBugReport, type WrittenReport } from '../report/render.js';
import type {
  A11yEvent,
  ActionEvent,
  BugEvent,
  LayoutEvent,
  LoopEvent,
  NetworkEvent,
  RecorderOptions,
  SessionData,
  SessionSummary,
  TestDataTag,
  TimelineEvent,
  ViewportEvent,
} from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const INJECTED_SCRIPT = readFileSync(join(here, '..', 'injected', 'recorder.js'), 'utf8');
const PANEL_SCRIPT = readFileSync(join(here, '..', 'injected', 'panel.js'), 'utf8');
/**
 * Hide the panel (and check overlays) in bug report screenshots so they show
 * only the app. Playwright applies this style to the live page while it
 * captures, so the panel briefly disappears on screen. That is fine for a bug
 * report the tester asked for, but not for the automatic screenshot after
 * every action: it made the panel flicker on each click. Step screenshots
 * therefore keep the panel in the picture.
 */
const SCREENSHOT_STYLE = 'qa-recorder-panel, qa-recorder-overlay { display: none !important; }';
/** Accessibility and layout evidence keeps the numbered overlay boxes. */
const AUDIT_SCREENSHOT_STYLE = 'qa-recorder-panel { display: none !important; }';
/** A tagged value must show up as an action within this time to get its tag. */
const TAG_WINDOW_MS = 5_000;
/** Recent API calls kept in full (headers and body) for "Mock this". */
const RECENT_CALLS = 40;
const MAX_RECENT_BODY = 200_000;

const MAX_REQUEST_BODY = 4_000;
const MAX_RESPONSE_BODY = 10_000;
/** A network call within this window after an action is attributed to it. */
const TRIGGER_WINDOW_MS = 3_000;
const SCREENSHOT_DELAY_MS = 400;
const SAVE_DEBOUNCE_MS = 1_000;
const MASK = '********';

type EventInput<T extends TimelineEvent> = T extends TimelineEvent
  ? Omit<T, 'seq' | 'timestamp' | 'elapsedMs'> & { timestamp?: number }
  : never;

interface RawAction {
  kind: ActionEvent['action'];
  locator: ActionEvent['locator'];
  element: ActionEvent['element'];
  url: string;
  timestamp: number;
  value?: string;
  sensitive?: boolean;
  values?: string[];
  labels?: string[];
  key?: string;
  files?: string[];
  button?: ActionEvent['button'];
  modifiers?: string[];
}

function timestampFolder(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function truncate(text: string | null | undefined, max: number): string | undefined {
  if (text == null) return undefined;
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text;
}

/**
 * Records one browsing session: user actions, API calls, console output and
 * navigation, as one ordered timeline written to `<outDir>/<timestamp>/session.json`.
 */
export class Recorder {
  readonly sessionDir: string;
  readonly events: TimelineEvent[] = [];

  browser!: Browser;
  context!: BrowserContext;
  /** The first tab. */
  page!: Page;

  /** Test data generator, profiles and looper behind the in-page panel. */
  data!: DataService;
  /** API mock rules and interception. */
  mocks!: MockService;
  /** Accessibility scans, responsive layout checks and resizing. */
  audit!: AuditService;

  private readonly options: Required<Omit<RecorderOptions, 'url' | 'executablePath' | 'onEvent' | 'seed' | 'device'>> &
    Pick<RecorderOptions, 'url' | 'executablePath' | 'onEvent' | 'seed' | 'device'>;
  private readonly startedAt = new Date();
  private seq = 0;
  private pageIds = new WeakMap<Page, number>();
  private nextPageId = 1;
  private requestStarts = new WeakMap<Request, { start: number; triggeredBy?: number }>();
  private actionFrames = new WeakMap<ActionEvent, Frame>();
  private screenshotTimers = new Map<Page, NodeJS.Timeout>();
  private saveTimer?: NodeJS.Timeout;
  private pending = new Set<Promise<unknown>>();
  private stopped?: Promise<SessionData>;
  private closedListeners: Array<() => void> = [];
  private pagesById = new Map<number, Page>();
  private expectedTags = new Map<string, { tag: TestDataTag; at: number }>();
  private loopContext?: { runId: number; iteration: number };
  private inflight = 0;
  private userAgent?: string;
  /** seq of the last bug report, so the next one can start after it. */
  private lastBugSeq = 0;
  private recent: RecentCall[] = [];
  private mockBroadcastTimer?: NodeJS.Timeout;
  private initialViewport?: { width: number; height: number };

  constructor(options: RecorderOptions = {}) {
    this.options = {
      outDir: 'recordings',
      slowThresholdMs: 1_000,
      screenshots: true,
      keepSecrets: false,
      captureWarnings: true,
      apiResourceTypes: ['xhr', 'fetch'],
      headless: false,
      panel: true,
      profilesPath: join('.qa-recorder', 'profiles.json'),
      mocksPath: join('.qa-recorder', 'mocks.json'),
      ...options,
    };
    this.sessionDir = resolve(this.options.outDir, timestampFolder(this.startedAt));
  }

  /** Launch the browser and start recording. */
  async start(): Promise<this> {
    mkdirSync(join(this.sessionDir, 'screenshots'), { recursive: true });

    this.browser = await chromium.launch({
      headless: this.options.headless,
      executablePath: this.options.executablePath,
    });
    let emulation: BrowserContextOptions = { viewport: this.options.headless ? { width: 1280, height: 800 } : null };
    if (this.options.device) {
      const descriptor = devices[this.options.device];
      if (!descriptor) {
        await this.browser.close();
        throw new Error(`Unknown device "${this.options.device}". Run "qa-recorder devices" to list them.`);
      }
      const { defaultBrowserType: _ignored, ...rest } = descriptor;
      emulation = rest;
    }
    this.context = await this.browser.newContext({
      ...emulation,
      recordHar: { path: join(this.sessionDir, 'network.har'), content: 'embed' },
    });

    await this.context.exposeBinding('__qaRecord', (source, payload: RawAction) => {
      this.onAction(source.page, source.frame, payload);
    });
    await this.context.addInitScript({ content: INJECTED_SCRIPT });

    this.data = new DataService(this.dataHost(), resolve(this.options.profilesPath), this.options.seed);
    await this.context.exposeBinding('__qaFocus', (source, payload) => {
      this.track(
        this.resolveFramePath(source.frame).then((framePath) =>
          this.data.onFocus(source.page, source.frame, payload, framePath),
        ),
      );
    });
    this.mocks = new MockService(this.context, resolve(this.options.mocksPath), {
      apiResourceTypes: this.options.apiResourceTypes,
      recentCalls: () => [...this.recent].reverse(),
      broadcast: (state) => this.broadcast('mocksChanged', state),
      log: (message) => this.push({ type: 'console', pageId: 0, level: 'warning', text: `[qa-recorder] ${message}` }),
    });
    await this.mocks.start();
    this.audit = new AuditService(this.auditHost());
    await this.context.exposeBinding('__qaPanel', (source, command: { cmd: string; [key: string]: unknown }) => {
      if (command?.cmd?.startsWith('mock')) return this.mocks.handle(command);
      if (AuditService.COMMANDS.has(command?.cmd)) return this.audit.handle(source.page, command);
      if (command?.cmd === 'bugDraft' || command?.cmd === 'createBug') return this.handleBugCommand(source.page, command);
      return this.data.handle(source.page, command);
    });
    if (this.options.panel) await this.context.addInitScript({ content: PANEL_SCRIPT });

    this.context.on('page', (page) => this.attachPage(page, true));
    this.context.on('request', (request) => this.onRequest(request));
    this.context.on('requestfinished', (request) => this.track(this.onRequestFinished(request)));
    this.context.on('requestfailed', (request) => this.onRequestFailed(request));
    this.browser.on('disconnected', () => this.closedListeners.forEach((fn) => fn()));

    this.page = await this.context.newPage();
    this.initialViewport = this.page.viewportSize() ?? undefined;
    this.userAgent = await this.page.evaluate(() => navigator.userAgent).catch(() => undefined);
    if (this.options.url) {
      await this.page.goto(this.options.url).catch((error: Error) => {
        // Keep recording even if the first page fails to load; the failure is itself useful.
        this.push({ type: 'pageerror', pageId: 1, message: `Failed to open ${this.options.url}: ${error.message}` });
      });
    }
    return this;
  }

  /** Resolves when the user closes every tab or the browser. */
  waitForClose(): Promise<void> {
    return new Promise((resolveClose) => {
      const check = () => {
        if (!this.browser.isConnected() || this.context.pages().length === 0) resolveClose();
      };
      this.closedListeners.push(resolveClose);
      this.context.on('close', () => resolveClose());
      this.context.on('page', (page) => page.on('close', check));
      this.page.on('close', check);
    });
  }

  /** Stop recording, flush the HAR file and session.json, and close the browser. */
  stop(): Promise<SessionData> {
    this.stopped ??= this.doStop();
    return this.stopped;
  }

  /** Session data as recorded so far. */
  snapshot(): SessionData {
    return {
      version: 1,
      meta: {
        startUrl: this.options.url,
        startedAt: this.startedAt.toISOString(),
        browser: `chromium ${this.browser?.version() ?? ''}`.trim(),
        slowThresholdMs: this.options.slowThresholdMs,
        userAgent: this.userAgent,
        dataSeed: this.data?.generator.seed,
        ...(this.options.device && { device: this.options.device }),
        ...(this.initialViewport && { viewport: this.initialViewport }),
      },
      summary: this.summarize(),
      events: [...this.events].sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq),
    };
  }

  /**
   * Writes a bug report (HTML, Markdown and JSON) from what has been recorded
   * so far, with a screenshot of the current page.
   */
  async createBug(input: BugInput & { scope?: 'session' | 'since-last-bug'; page?: Page } = {}): Promise<WrittenReport> {
    const page = input.page && !input.page.isClosed() ? input.page : this.page;
    await this.settle();
    let screenshot: string | undefined;
    if (!page.isClosed()) {
      screenshot = `screenshots/bug-${String(this.seq + 1).padStart(4, '0')}.png`;
      await page.screenshot({ path: join(this.sessionDir, screenshot), style: SCREENSHOT_STYLE }).catch(() => {
        screenshot = undefined;
      });
    }
    const fromSeq = input.fromSeq ?? (input.scope === 'since-last-bug' ? this.lastBugSeq : 0);
    const { page: _page, scope: _scope, ...rest } = input;
    const written = writeBugReport(this.sessionDir, this.snapshot(), { ...rest, fromSeq, screenshot });
    const bug = this.push<BugEvent>({
      type: 'bug',
      pageId: this.pageId(page),
      title: written.report.title,
      reportDir: written.dir.slice(this.sessionDir.length + 1).replace(/\\/g, '/'),
    });
    this.lastBugSeq = bug.seq;
    return written;
  }

  /** Calls a method on the panel in every open tab. */
  private broadcast(method: string, payload: unknown): void {
    for (const page of this.context.pages()) {
      void page.mainFrame()
        .evaluate(
          ([m, p]) => {
            const ui = (window as unknown as { __qaPanelUi?: Record<string, (x: unknown) => void> }).__qaPanelUi;
            ui?.[m]?.(p);
          },
          [method, payload] as const,
        )
        .catch(() => undefined);
    }
  }

  private async handleBugCommand(page: Page, command: { cmd: string; [key: string]: unknown }) {
    try {
      if (command.cmd === 'bugDraft') {
        const scope = command.scope === 'since-last-bug' ? 'since-last-bug' : 'session';
        return {
          ok: true,
          result: { ...bugDraft(this.snapshot(), scope === 'since-last-bug' ? this.lastBugSeq : 0), hasPreviousBug: this.lastBugSeq > 0 },
        };
      }
      const input = (command.bug ?? {}) as BugInput & { scope?: 'session' | 'since-last-bug' };
      const written = await this.createBug({ ...input, page });
      return { ok: true, result: { title: written.report.title, dir: written.dir, html: written.html, markdown: written.markdown } };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  // ---------- internals ----------

  private async doStop(): Promise<SessionData> {
    for (const timer of this.screenshotTimers.values()) clearTimeout(timer);
    if (this.mockBroadcastTimer) clearTimeout(this.mockBroadcastTimer);
    this.screenshotTimers.clear();
    await this.settle();
    const data = this.snapshot();
    data.meta.endedAt = new Date().toISOString();
    try {
      data.meta.userAgent = await this.page.evaluate(() => navigator.userAgent);
    } catch {
      /* page already closed */
    }
    if (this.saveTimer) clearTimeout(this.saveTimer);
    await this.audit?.close();
    // Closing the context writes the HAR file.
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
    writeFileSync(join(this.sessionDir, 'session.json'), JSON.stringify(data, null, 2));
    return data;
  }

  private async settle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private track<T>(promise: Promise<T>): void {
    const tracked = promise.catch(() => undefined).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  private pageId(page: Page | null | undefined): number {
    if (!page) return 0;
    let id = this.pageIds.get(page);
    if (!id) {
      id = this.nextPageId++;
      this.pageIds.set(page, id);
    }
    return id;
  }

  private push<T extends TimelineEvent>(input: EventInput<T>): T {
    const timestamp = input.timestamp ?? Date.now();
    const event = {
      ...input,
      seq: ++this.seq,
      timestamp,
      elapsedMs: timestamp - this.startedAt.getTime(),
    } as unknown as T;
    this.events.push(event);
    this.options.onEvent?.(event);
    this.scheduleSave();
    return event;
  }

  private scheduleSave(): void {
    if (this.stopped || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      if (this.stopped) return;
      try {
        writeFileSync(join(this.sessionDir, 'session.json'), JSON.stringify(this.snapshot(), null, 2));
      } catch {
        /* best effort; the final save happens on stop */
      }
    }, SAVE_DEBOUNCE_MS);
  }

  private attachPage(page: Page, isNew: boolean): void {
    const pageId = this.pageId(page);
    this.pagesById.set(pageId, page);
    page.on('close', () => this.pagesById.delete(pageId));
    if (isNew && pageId > 1) {
      this.push({ type: 'navigation', pageId, url: page.url(), newPage: true });
    }
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.push({ type: 'navigation', pageId, url: frame.url() });
    });
    page.on('console', (message) => {
      const type = message.type();
      if (type !== 'error' && !(type === 'warning' && this.options.captureWarnings)) return;
      const loc = message.location();
      this.push({
        type: 'console',
        pageId,
        level: type === 'error' ? 'error' : 'warning',
        text: message.text(),
        location: loc.url ? `${loc.url}:${loc.lineNumber + 1}:${loc.columnNumber + 1}` : undefined,
      });
    });
    page.on('pageerror', (error) => {
      this.push({ type: 'pageerror', pageId, message: error.message, stack: error.stack });
    });
  }

  private lastActionBefore(time: number): ActionEvent | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i];
      if (event.type !== 'action') continue;
      if (time - event.timestamp > TRIGGER_WINDOW_MS) return undefined;
      return event;
    }
    return undefined;
  }

  private onAction(page: Page, frame: Frame, raw: RawAction): void {
    if (this.stopped) return;
    const pageId = this.pageId(page);
    const masked = raw.sensitive && !this.options.keepSecrets;
    const value = masked && raw.value !== undefined ? MASK : raw.value;

    const testData = this.takeTestData(pageId, raw);

    // Typing fires one input event per keystroke; keep only the final value.
    const last = this.events[this.events.length - 1];
    if (
      raw.kind === 'fill' &&
      last?.type === 'action' &&
      last.action === 'fill' &&
      last.locator.selector === raw.locator.selector &&
      this.actionFrames.get(last) === frame
    ) {
      last.value = value;
      if (testData) last.testData = testData;
      last.timestamp = raw.timestamp;
      last.elapsedMs = raw.timestamp - this.startedAt.getTime();
      this.scheduleSave();
      this.scheduleScreenshot(page, last);
      return;
    }

    const event = this.push<ActionEvent>({
      type: 'action',
      pageId,
      action: raw.kind,
      locator: raw.locator,
      framePath: [],
      element: raw.element,
      url: raw.url,
      timestamp: raw.timestamp,
      ...(value !== undefined && { value }),
      ...(raw.sensitive && { sensitive: true }),
      ...(raw.values && { values: raw.values }),
      ...(raw.labels && { labels: raw.labels }),
      ...(raw.key && { key: raw.key }),
      ...(raw.files && { files: raw.files }),
      ...(raw.button && raw.button !== 'left' && { button: raw.button }),
      ...(raw.modifiers?.length && { modifiers: raw.modifiers }),
      ...(testData && { testData }),
      ...(this.loopContext && { loop: { ...this.loopContext } }),
    });
    this.actionFrames.set(event, frame);
    if (frame !== page.mainFrame()) this.track(this.resolveFramePath(frame).then((path) => (event.framePath = path)));
    this.scheduleScreenshot(page, event);
  }

  /** Selectors for each iframe element from the top page down to `frame`. */
  private async resolveFramePath(frame: Frame): Promise<string[]> {
    const path: string[] = [];
    for (let current: Frame | null = frame; current?.parentFrame(); current = current.parentFrame()) {
      const handle = await current.frameElement();
      const selector = await handle.evaluate((el: Element) => {
        const recorder = (window as unknown as { __qaRecorder?: { selectorFor(e: Element): { selector: string } } })
          .__qaRecorder;
        if (recorder) return recorder.selectorFor(el).selector;
        return el.id ? `#${el.id}` : 'iframe';
      });
      await handle.dispose();
      path.unshift(selector);
    }
    return path;
  }

  private scheduleScreenshot(page: Page, event: ActionEvent): void {
    if (!this.options.screenshots) return;
    const existing = this.screenshotTimers.get(page);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.screenshotTimers.delete(page);
      if (this.stopped || page.isClosed()) return;
      const file = `screenshots/${String(event.seq).padStart(4, '0')}-${event.action}.png`;
      this.track(
        page.screenshot({ path: join(this.sessionDir, file) }).then(() => {
          event.screenshot = file;
          this.scheduleSave();
        }),
      );
    }, SCREENSHOT_DELAY_MS);
    this.screenshotTimers.set(page, timer);
  }

  private isApi(request: Request): boolean {
    return this.options.apiResourceTypes.includes(request.resourceType());
  }

  private onRequest(request: Request): void {
    if (!this.isApi(request)) return;
    const start = Date.now();
    this.inflight++;
    this.requestStarts.set(request, { start, triggeredBy: this.lastActionBefore(start)?.seq });
  }

  private baseNetwork(request: Request) {
    const started = this.requestStarts.get(request);
    let pageId = 0;
    try {
      pageId = this.pageId(request.frame().page());
    } catch {
      /* service worker requests have no frame */
    }
    return {
      started,
      fields: {
        type: 'network' as const,
        pageId,
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        requestBody: truncate(request.postData(), MAX_REQUEST_BODY),
        ...(started?.triggeredBy !== undefined && { triggeredBy: started.triggeredBy }),
        timestamp: started?.start,
      },
    };
  }

  private settleRequest(request: Request): void {
    if (this.requestStarts.has(request)) this.inflight = Math.max(0, this.inflight - 1);
  }

  private async onRequestFinished(request: Request): Promise<void> {
    if (!this.isApi(request)) return;
    this.settleRequest(request);
    const { started, fields } = this.baseNetwork(request);
    const response = await request.response();
    const timing = request.timing();
    const durationMs =
      timing.responseEnd >= 0 ? Math.round(timing.responseEnd) : started ? Date.now() - started.start : undefined;
    const ttfbMs = timing.responseStart >= 0 ? Math.round(timing.responseStart) : undefined;
    const status = response?.status();
    const isError = status !== undefined && status >= 400;

    let responseBody: string | undefined;
    if (isError && response) responseBody = truncate(await response.text().catch(() => undefined), MAX_RESPONSE_BODY);
    const sizes = await request.sizes().catch(() => undefined);
    const mock = this.mocks?.appliedTo(request);

    const event = this.push<NetworkEvent>({
      ...fields,
      status,
      statusText: response?.statusText(),
      durationMs,
      ttfbMs,
      responseSize: sizes?.responseBodySize,
      responseBody,
      isError,
      isSlow: durationMs !== undefined && durationMs >= this.options.slowThresholdMs,
      ...(mock && { mock }),
    });
    await this.rememberCall(event, request);
  }

  /** Keeps the last few API calls in full so the QA can turn one into a mock. */
  private async rememberCall(event: NetworkEvent, request: Request): Promise<void> {
    const response = await request.response().catch(() => null);
    const contentType = response ? ((await response.allHeaders().catch(() => ({}))) as Record<string, string>)['content-type'] ?? '' : '';
    const textual = /json|text|xml|javascript|x-www-form-urlencoded/i.test(contentType) || contentType === '';
    const body = response && textual ? await response.text().catch(() => undefined) : undefined;
    this.recent.push({
      seq: event.seq,
      method: event.method,
      url: event.url,
      status: event.status,
      requestHeaders: await request.allHeaders().catch(() => undefined),
      requestBody: request.postData() ?? undefined,
      responseHeaders: response ? await response.allHeaders().catch(() => undefined) : undefined,
      responseBody: body !== undefined && body.length <= MAX_RECENT_BODY ? body : undefined,
      mocked: event.mock?.rule,
    });
    if (this.recent.length > RECENT_CALLS) this.recent.shift();
    // Many calls can finish together; update the panels once.
    if (!this.mockBroadcastTimer) {
      this.mockBroadcastTimer = setTimeout(() => {
        this.mockBroadcastTimer = undefined;
        if (!this.stopped) this.broadcast('mocksChanged', this.mocks.state());
      }, 300);
    }
  }

  private onRequestFailed(request: Request): void {
    if (!this.isApi(request)) return;
    this.settleRequest(request);
    const { started, fields } = this.baseNetwork(request);
    const mock = this.mocks?.appliedTo(request);
    this.push<NetworkEvent>({
      ...fields,
      durationMs: started ? Date.now() - started.start : undefined,
      failure: request.failure()?.errorText ?? 'failed',
      isError: true,
      isSlow: false,
      ...(mock && { mock }),
    });
  }

  private takeTestData(pageId: number, raw: RawAction): TestDataTag | undefined {
    if (raw.kind !== 'fill' && raw.kind !== 'select') return undefined;
    const key = `${pageId}|${raw.locator.selector}`;
    const expected = this.expectedTags.get(key);
    if (!expected) return undefined;
    this.expectedTags.delete(key);
    return Date.now() - expected.at <= TAG_WINDOW_MS ? expected.tag : undefined;
  }

  private auditHost() {
    return {
      sessionDir: this.sessionDir,
      executablePath: this.options.executablePath,
      screenshotStyle: AUDIT_SCREENSHOT_STYLE,
      nextSeq: () => this.seq + 1,
      pageIdOf: (page: Page) => this.pageId(page),
      pushA11y: (event: Omit<A11yEvent, 'seq' | 'timestamp' | 'elapsedMs' | 'type'>) => this.push<A11yEvent>({ type: 'a11y', ...event }),
      pushLayout: (event: Omit<LayoutEvent, 'seq' | 'timestamp' | 'elapsedMs' | 'type'>) => this.push<LayoutEvent>({ type: 'layout', ...event }),
      pushViewport: (event: Omit<ViewportEvent, 'seq' | 'timestamp' | 'elapsedMs' | 'type'>) => this.push<ViewportEvent>({ type: 'viewport', ...event }),
    };
  }

  private dataHost() {
    return {
      pageById: (id: number) => this.pagesById.get(id),
      pageIdOf: (page: Page) => this.pageId(page),
      actions: () => this.events.filter((e): e is ActionEvent => e.type === 'action'),
      lastSeq: () => this.seq,
      expectTestData: (pageId: number, selector: string, tag: TestDataTag) => {
        this.expectedTags.set(`${pageId}|${selector}`, { tag, at: Date.now() });
      },
      setLoopContext: (context: { runId: number; iteration: number } | undefined) => {
        this.loopContext = context;
      },
      pushLoopEvent: (event: Omit<LoopEvent, 'seq' | 'timestamp' | 'elapsedMs' | 'type'>) => {
        this.push<LoopEvent>({ type: 'loop', ...event });
      },
      waitForApiIdle: async (timeoutMs: number) => {
        const deadline = Date.now() + timeoutMs;
        // Give a just-clicked request a moment to start before checking.
        await new Promise((r) => setTimeout(r, 100));
        while (this.inflight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      },
    };
  }

  private summarize(): SessionSummary {
    const network = this.events.filter((e): e is NetworkEvent => e.type === 'network');
    const timed = network.filter((e) => e.durationMs !== undefined);
    return {
      actions: this.events.filter((e) => e.type === 'action').length,
      apiCalls: network.length,
      failedApiCalls: network.filter((e) => e.isError).length,
      slowApiCalls: network.filter((e) => e.isSlow).length,
      consoleErrors: this.events.filter((e) => e.type === 'console' && e.level === 'error').length,
      consoleWarnings: this.events.filter((e) => e.type === 'console' && e.level === 'warning').length,
      pageErrors: this.events.filter((e) => e.type === 'pageerror').length,
      avgApiDurationMs: timed.length
        ? Math.round(timed.reduce((sum, e) => sum + (e.durationMs ?? 0), 0) / timed.length)
        : undefined,
    };
  }
}

/** Launch a recording browser. Call `stop()` on the result to finish and save the session. */
export async function startRecording(options: RecorderOptions = {}): Promise<Recorder> {
  return new Recorder(options).start();
}
