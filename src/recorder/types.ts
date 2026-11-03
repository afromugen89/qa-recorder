import type { GeneratorSpec } from '../data/faker.js';
import type { TechniqueId } from '../data/techniques.js';

export type ActionKind =
  | 'click'
  | 'dblclick'
  | 'fill'
  | 'check'
  | 'uncheck'
  | 'select'
  | 'press'
  | 'setInputFiles';

export interface Locator {
  /** How the locator was chosen, best first: testid, role, label, placeholder, css. */
  strategy: 'testid' | 'role' | 'label' | 'placeholder' | 'css';
  /** Selector accepted by Playwright's `page.locator()`. */
  selector: string;
  /** Readable Playwright locator call, e.g. `getByRole("button", { name: "Save" })`. */
  code: string;
}

export interface ElementInfo {
  tag: string;
  type?: string;
  id?: string;
  name?: string;
  role?: string;
  accessibleName?: string;
  text?: string;
  inShadowDom: boolean;
  /** Elements in closed shadow roots are recorded but cannot be replayed by Playwright. */
  inClosedShadowDom: boolean;
}

interface BaseEvent {
  /** Order of the event in the session, starting at 1. */
  seq: number;
  /** Epoch milliseconds. */
  timestamp: number;
  /** Milliseconds since recording started. */
  elapsedMs: number;
  /** Which tab the event came from, starting at 1. */
  pageId: number;
}

/** Where a value typed by the tool came from, and which ISTQB technique it applies. */
export interface TestDataTag {
  source: 'faker' | 'boundary' | 'partition' | 'edge-case' | 'profile' | 'loop' | 'manual';
  technique?: TechniqueId;
  /** e.g. "max + 1 (51 chars)" or "Email". */
  label: string;
  /** What a correct implementation should do with the value. */
  expected?: 'valid' | 'invalid';
  /** The generator, so the value can be regenerated (looper, profiles). */
  spec?: GeneratorSpec;
}

export interface ActionEvent extends BaseEvent {
  type: 'action';
  action: ActionKind;
  locator: Locator;
  /** Frame selectors from the top page down to the element's frame. Empty for the main frame. */
  framePath: string[];
  element: ElementInfo;
  url: string;
  value?: string;
  sensitive?: boolean;
  values?: string[];
  labels?: string[];
  key?: string;
  files?: string[];
  button?: 'left' | 'right' | 'middle';
  modifiers?: string[];
  /** Screenshot taken just after the action, relative to the session folder. */
  screenshot?: string;
  /** Set when the value came from the test data panel, a profile or the looper. */
  testData?: TestDataTag;
  /** Set when the action was replayed by the looper. */
  loop?: { runId: number; iteration: number };
}

export interface NetworkEvent extends BaseEvent {
  type: 'network';
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  /** Total time from request start to last response byte. */
  durationMs?: number;
  /** Time to first byte. */
  ttfbMs?: number;
  responseSize?: number;
  requestBody?: string;
  /** Response body, kept only for failed requests. */
  responseBody?: string;
  failure?: string;
  isError: boolean;
  isSlow: boolean;
  /** seq of the user action that most likely triggered this call. */
  triggeredBy?: number;
}

export interface ConsoleEvent extends BaseEvent {
  type: 'console';
  level: 'error' | 'warning';
  text: string;
  location?: string;
}

export interface PageErrorEvent extends BaseEvent {
  type: 'pageerror';
  message: string;
  stack?: string;
}

export interface NavigationEvent extends BaseEvent {
  type: 'navigation';
  url: string;
  /** True when a new tab or popup was opened. */
  newPage?: boolean;
}

/** Looper milestones: capturing a flow and each replayed iteration. */
export interface LoopEvent extends BaseEvent {
  type: 'loop';
  phase: 'capture-start' | 'capture-end' | 'run-start' | 'iteration' | 'run-end';
  runId?: number;
  iteration?: number;
  total?: number;
  steps?: number;
  passed?: number;
  stopped?: boolean;
  error?: string;
}

/** A bug report was created at this point. */
export interface BugEvent extends BaseEvent {
  type: 'bug';
  title: string;
  /** Report folder, relative to the session folder. */
  reportDir: string;
}

export type TimelineEvent = ActionEvent | NetworkEvent | ConsoleEvent | PageErrorEvent | NavigationEvent | LoopEvent | BugEvent;

export interface SessionSummary {
  actions: number;
  apiCalls: number;
  failedApiCalls: number;
  slowApiCalls: number;
  consoleErrors: number;
  consoleWarnings: number;
  pageErrors: number;
  /** Average API response time in ms. */
  avgApiDurationMs?: number;
}

export interface SessionData {
  version: 1;
  meta: {
    startUrl?: string;
    startedAt: string;
    endedAt?: string;
    browser: string;
    userAgent?: string;
    slowThresholdMs: number;
    /** Faker seed; the same seed reproduces the same generated data. */
    dataSeed?: number;
  };
  summary: SessionSummary;
  events: TimelineEvent[];
}

export interface RecorderOptions {
  /** URL to open when recording starts. */
  url?: string;
  /** Folder to write the session into. A timestamped subfolder is created. Default: ./recordings */
  outDir?: string;
  /** API calls slower than this are flagged. Default 1000 ms. */
  slowThresholdMs?: number;
  /** Take a screenshot after each action. Default true. */
  screenshots?: boolean;
  /** Record password and card values instead of masking them. Default false. */
  keepSecrets?: boolean;
  /** Record console warnings as well as errors. Default true. */
  captureWarnings?: boolean;
  /** Resource types logged as API calls. Default ['xhr', 'fetch']. */
  apiResourceTypes?: string[];
  /** Run without a visible window (for CI and tests). Default false. */
  headless?: boolean;
  /** Path to a Chromium binary, if not using Playwright's bundled one. */
  executablePath?: string;
  /** Show the test data panel in the page. Default true. */
  panel?: boolean;
  /** Where data profiles are stored. Default ./.qa-recorder/profiles.json */
  profilesPath?: string;
  /** Faker seed, to reproduce generated data. Random by default. */
  seed?: number;
  /** Called for each event as it is recorded. */
  onEvent?: (event: TimelineEvent) => void;
}
