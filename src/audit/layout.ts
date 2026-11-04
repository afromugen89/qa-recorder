import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devices, type Browser, type BrowserContextOptions, type Page } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const AUDIT_SCRIPT = readFileSync(join(here, '..', 'injected', 'audit.js'), 'utf8');

/** Below this width the phone checks (tap targets, text size, viewport tag) run. */
export const MOBILE_MAX_WIDTH = 767;

export interface ViewportPreset {
  /** Playwright device name, or "laptop" / "desktop". */
  id: string;
  name: string;
  group: 'Phone' | 'Tablet' | 'Desktop';
  width: number;
  height: number;
  isMobile: boolean;
  /** Playwright device descriptor name, for real user agent, touch and pixel ratio. */
  device?: string;
}

const DEVICE_PRESETS: [string, ViewportPreset['group']][] = [
  ['Galaxy S9+', 'Phone'],
  ['iPhone SE (3rd gen)', 'Phone'],
  ['iPhone 15 Pro', 'Phone'],
  ['Pixel 7', 'Phone'],
  ['iPad Mini', 'Tablet'],
  ['iPad Pro 11', 'Tablet'],
];

export const VIEWPORT_PRESETS: ViewportPreset[] = [
  ...DEVICE_PRESETS.filter(([name]) => devices[name]).map(([name, group]) => ({
    id: name,
    name,
    group,
    width: devices[name].viewport.width,
    height: devices[name].viewport.height,
    isMobile: Boolean(devices[name].isMobile),
    device: name,
  })),
  { id: 'laptop', name: 'Laptop', group: 'Desktop', width: 1366, height: 768, isMobile: false },
  { id: 'desktop', name: 'Desktop', group: 'Desktop', width: 1920, height: 1080, isMobile: false },
];

/** Checked by default: a small phone, a large phone, a tablet and a laptop. */
export const DEFAULT_PRESETS = ['iPhone SE (3rd gen)', 'Pixel 7', 'iPad Mini', 'laptop'];

export interface LayoutIssue {
  kind: 'horizontal-scroll' | 'overflow' | 'small-target' | 'overlap' | 'small-text' | 'meta-viewport' | 'zoom-disabled';
  severity: 'error' | 'warning';
  message: string;
  /** Locator of the element, when the issue is about one element. */
  target?: string;
  /** Position on the page, for the screenshot overlay. */
  box?: { x: number; y: number; w: number; h: number };
  /** Number shown on the screenshot. */
  marker?: number;
}

/** One size to check. */
export interface LayoutTarget {
  label: string;
  width: number;
  height: number;
  isMobile: boolean;
  device?: string;
  /** Why this width: set for CSS breakpoint boundaries (boundary value analysis). */
  boundary?: string;
}

export interface ViewportResult extends LayoutTarget {
  /** False for "this tab as it is now"; true when the URL was loaded fresh at this size. */
  fresh: boolean;
  pageWidth?: number;
  issues: LayoutIssue[];
  /** Relative to the session folder. */
  screenshot?: string;
  /** Set when the page could not be checked at this size. */
  error?: string;
}

export interface LayoutResult {
  url: string;
  viewports: ViewportResult[];
}

export interface LayoutRequest {
  /** Preset ids from VIEWPORT_PRESETS. */
  presets?: string[];
  /** Turn phones and tablets sideways. */
  landscape?: boolean;
  /** Extra widths, checked as desktop windows 800 px tall. */
  widths?: number[];
  /** Breakpoint boundary widths (from detectBreakpoints). */
  boundaries?: { width: number; reason: string }[];
  /** Also check the current tab as it is now, keeping its state. Default true. */
  current?: boolean;
  /** Capture the whole page instead of the first three screens. Default false. */
  fullPage?: boolean;
}

/** Turns a request into the list of sizes to check. */
export function layoutTargets(request: LayoutRequest): LayoutTarget[] {
  const out: LayoutTarget[] = [];
  for (const id of request.presets ?? []) {
    const preset = VIEWPORT_PRESETS.find((p) => p.id === id);
    if (!preset) throw new Error(`Unknown viewport "${id}"`);
    const landscapeName = preset.device && request.landscape ? `${preset.device} landscape` : undefined;
    if (landscapeName && devices[landscapeName]) {
      const d = devices[landscapeName];
      out.push({ label: `${preset.name} landscape`, width: d.viewport.width, height: d.viewport.height, isMobile: preset.isMobile, device: landscapeName });
    } else {
      out.push({ label: preset.name, width: preset.width, height: preset.height, isMobile: preset.isMobile, ...(preset.device && { device: preset.device }) });
    }
  }
  for (const width of request.widths ?? []) {
    const w = Math.round(Number(width));
    if (!Number.isFinite(w) || w < 200 || w > 4000) throw new Error(`Width must be between 200 and 4000 px, got "${width}"`);
    out.push({ label: `${w} px wide`, width: w, height: 800, isMobile: false });
  }
  for (const b of request.boundaries ?? []) {
    out.push({ label: `${b.width} px (${b.reason})`, width: b.width, height: 800, isMobile: false, boundary: b.reason });
  }
  // The same size twice gives the same answer.
  const seen = new Set<string>();
  return out.filter((t) => {
    const key = `${t.width}x${t.height}|${t.device ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------- CSS breakpoints ----------

export interface Breakpoint {
  /** The media condition, e.g. "min-width: 768px". */
  condition: string;
  /** Widest size on the lower side of the breakpoint; `below + 1` is on the other side. */
  below: number;
}

const UNIT_PX: Record<string, number> = { px: 1, em: 16, rem: 16, '': 1 };

/**
 * Finds width breakpoints in @media conditions. For each one, returns the
 * last width before it switches, so the layout can be checked on both sides
 * (two-value boundary value analysis).
 */
export function parseBreakpoints(mediaTexts: string[]): Breakpoint[] {
  const found = new Map<number, string>();
  const add = (op: '>=' | '>' | '<=' | '<', value: number, unit: string, text: string) => {
    const px = value * (UNIT_PX[unit.toLowerCase()] ?? 1);
    if (!Number.isFinite(px) || px < 200 || px > 4000) return;
    // `below` is the last width on the narrow side of the switch.
    const below = op === '>=' ? Math.ceil(px) - 1 : op === '>' ? Math.floor(px) : op === '<=' ? Math.floor(px) : Math.ceil(px) - 1;
    if (!found.has(below)) found.set(below, text);
  };
  const flip = { '<=': '>=', '<': '>', '>=': '<=', '>': '<' } as const;
  for (const text of mediaTexts) {
    for (const m of text.matchAll(/(?<![-\w])(min|max)-width\s*:\s*([\d.]+)\s*(px|em|rem)?/gi)) {
      add(m[1].toLowerCase() === 'min' ? '>=' : '<=', Number(m[2]), m[3] ?? '', `${m[1].toLowerCase()}-width: ${m[2]}${m[3] ?? ''}`);
    }
    for (const m of text.matchAll(/(?<![-\w])width\s*(<=|>=|<|>)\s*([\d.]+)\s*(px|em|rem)?/gi)) {
      add(m[1] as '>=', Number(m[2]), m[3] ?? '', `width ${m[1]} ${m[2]}${m[3] ?? ''}`);
    }
    for (const m of text.matchAll(/([\d.]+)\s*(px|em|rem)?\s*(<=|>=|<|>)\s*width(?![-\w])/gi)) {
      add(flip[m[3] as '<='], Number(m[1]), m[2] ?? '', `${m[1]}${m[2] ?? ''} ${m[3]} width`);
    }
  }
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([below, condition]) => ({ condition, below }));
}

/** Boundary widths to check for each breakpoint: just before and just after the switch. */
export function boundaryWidths(breakpoints: Breakpoint[]): { width: number; reason: string }[] {
  return breakpoints.flatMap((b) => [
    { width: b.below, reason: `last width before ${b.condition}` },
    { width: b.below + 1, reason: `first width after ${b.condition}` },
  ]);
}

/** Reads the page's CSS (including stylesheets from other origins) and returns its width breakpoints. */
export async function detectBreakpoints(page: Page): Promise<{ breakpoints: Breakpoint[]; unreadable: string[] }> {
  await ensureAuditScript(page);
  const { media, unreadable } = await page.evaluate(() =>
    (window as unknown as { __qaAudit: { mediaQueries(): { media: string[]; unreadable: string[] } } }).__qaAudit.mediaQueries(),
  );
  const texts = [...media];
  const failed: string[] = [];
  // Cross-origin stylesheets can't be read from the page; fetch them with the tab's cookies.
  for (const href of [...new Set(unreadable)].slice(0, 30)) {
    try {
      const response = await page.context().request.get(href, { timeout: 10_000 });
      const css = await response.text();
      for (const m of css.matchAll(/@media([^{]+)\{/g)) texts.push(m[1]);
    } catch {
      failed.push(href);
    }
  }
  return { breakpoints: parseBreakpoints(texts), unreadable: failed };
}

// ---------- checking ----------

export async function ensureAuditScript(page: Page): Promise<void> {
  const present = await page.evaluate(() => Boolean((window as unknown as { __qaAudit?: unknown }).__qaAudit));
  if (!present) await page.evaluate(AUDIT_SCRIPT);
}

interface Box { x: number; y: number; w: number; h: number; label?: string; color?: string }

/**
 * Screenshot with numbered boxes drawn over problem elements. Captures the
 * full page width (so sideways overflow shows) and up to three screens of
 * height unless `fullPage` is set.
 */
export async function annotatedScreenshot(page: Page, boxes: Box[], path: string, options: { fullPage?: boolean; style?: string } = {}): Promise<void> {
  await ensureAuditScript(page);
  try {
    await page.evaluate((b) => (window as unknown as { __qaAudit: { overlay(b: Box[]): number } }).__qaAudit.overlay(b), boxes);
    const size = await page.evaluate(() => ({
      width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
      height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
      screen: window.innerHeight,
    }));
    const height = options.fullPage ? size.height : Math.min(size.height, size.screen * 3);
    await page.screenshot({
      path,
      fullPage: true,
      clip: { x: 0, y: 0, width: Math.max(1, size.width), height: Math.max(1, height) },
      scale: 'css',
      style: options.style,
    });
  } finally {
    await page.evaluate(() => (window as unknown as { __qaAudit?: { clearOverlay(): void } }).__qaAudit?.clearOverlay()).catch(() => undefined);
  }
}

/** Runs the layout checks on a page at its current size. */
export async function checkPage(page: Page, mobile: boolean): Promise<{ pageWidth: number; issues: LayoutIssue[] }> {
  await ensureAuditScript(page);
  const result = await page.evaluate(
    (m) => (window as unknown as { __qaAudit: { check(o: unknown): { pageWidth: number; issues: LayoutIssue[] } } }).__qaAudit.check({ mobile: m }),
    mobile,
  );
  let n = 0;
  for (const issue of result.issues) if (issue.box) issue.marker = ++n;
  return result;
}

const issueBoxes = (issues: LayoutIssue[]): Box[] =>
  issues.filter((i) => i.box && i.marker).map((i) => ({ ...i.box!, label: String(i.marker), color: i.severity === 'error' ? '#dc2626' : '#d97706' }));

export interface LayoutCheckOptions {
  /** Folder that screenshot paths are relative to. */
  sessionDir: string;
  /** File name prefix for screenshots, e.g. "screenshots/layout-0012". */
  screenshotPrefix: string;
  /** A browser for loading the page fresh at each size (headless is best). */
  browser: () => Promise<Browser>;
  /** CSS added to screenshots, e.g. to hide the QA panel. */
  style?: string;
  /** Called after each size is done. */
  onProgress?: (done: number, total: number) => void;
}

const fileSafe = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/**
 * Checks the layout of the page at several sizes. Each size loads the current
 * URL fresh in a separate, unrecorded browser context with the tab's cookies
 * and local storage, so the recorded tab is not disturbed. With `current`,
 * the tab itself is also checked as it is now.
 */
export async function runLayoutCheck(page: Page, request: LayoutRequest, options: LayoutCheckOptions): Promise<LayoutResult> {
  const targets = layoutTargets(request);
  const url = page.url();
  const viewports: ViewportResult[] = [];
  const total = targets.length + (request.current !== false ? 1 : 0);
  let done = 0;
  const shotPath = (label: string) => `${options.screenshotPrefix}-${fileSafe(label)}.png`;

  if (request.current !== false) {
    const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, height: window.innerHeight, touch: navigator.maxTouchPoints > 0 }));
    const isMobile = size.width <= MOBILE_MAX_WIDTH || size.touch;
    const label = `This tab (${size.width}×${size.height})`;
    const result: ViewportResult = { label, width: size.width, height: size.height, isMobile, fresh: false, issues: [] };
    try {
      const checked = await checkPage(page, isMobile);
      Object.assign(result, checked);
      const file = shotPath('current');
      await annotatedScreenshot(page, issueBoxes(checked.issues), join(options.sessionDir, file), { fullPage: request.fullPage, style: options.style });
      result.screenshot = file;
    } catch (error) {
      result.error = (error as Error).message.split('\n')[0];
    }
    viewports.push(result);
    options.onProgress?.(++done, total);
  }

  if (targets.length) {
    const browser = await options.browser();
    const storageState = await page.context().storageState().catch(() => undefined);
    const results: ViewportResult[] = new Array(targets.length);
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const index = next++;
        const target = targets[index];
        results[index] = await checkFresh(browser, url, target, storageState, request, options, shotPath(`${target.width}x${target.height}-${target.label}`));
        options.onProgress?.(++done, total);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    viewports.push(...results);
  }
  return { url, viewports };
}

async function checkFresh(
  browser: Browser,
  url: string,
  target: LayoutTarget,
  storageState: BrowserContextOptions['storageState'],
  request: LayoutRequest,
  options: LayoutCheckOptions,
  file: string,
): Promise<ViewportResult> {
  const result: ViewportResult = { ...target, fresh: true, issues: [] };
  const contextOptions: BrowserContextOptions = target.device
    ? { ...devices[target.device] }
    : { viewport: { width: target.width, height: target.height }, deviceScaleFactor: 1 };
  const context = await browser.newContext({ ...contextOptions, storageState, ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    const checked = await checkPage(page, target.isMobile || target.width <= MOBILE_MAX_WIDTH);
    Object.assign(result, checked);
    await annotatedScreenshot(page, issueBoxes(checked.issues), join(options.sessionDir, file), { fullPage: request.fullPage, style: options.style });
    result.screenshot = file;
  } catch (error) {
    result.error = (error as Error).message.split('\n')[0];
  } finally {
    await context.close().catch(() => undefined);
  }
  return result;
}

/** One line, e.g. "3 errors and 2 warnings at 2 of 5 sizes". */
export function layoutSummary(r: LayoutResult): string {
  const errors = r.viewports.reduce((s, v) => s + v.issues.filter((i) => i.severity === 'error').length, 0);
  const warnings = r.viewports.reduce((s, v) => s + v.issues.filter((i) => i.severity === 'warning').length, 0);
  const affected = r.viewports.filter((v) => v.issues.length).length;
  const failed = r.viewports.filter((v) => v.error).length;
  const notChecked = failed ? `${failed} size${failed > 1 ? 's' : ''} could not be checked` : '';
  if (failed === r.viewports.length) return `Could not check the layout: ${r.viewports[0]?.error ?? 'no sizes chosen'}`;
  if (!errors && !warnings) {
    const checked = r.viewports.length - failed;
    return `No layout issues at ${checked} size${checked > 1 ? 's' : ''}${notChecked ? `; ${notChecked}` : ''}`;
  }
  const parts = [errors && `${errors} error${errors > 1 ? 's' : ''}`, warnings && `${warnings} warning${warnings > 1 ? 's' : ''}`].filter(Boolean).join(' and ');
  return `${parts} at ${affected} of ${r.viewports.length} sizes${notChecked ? `; ${notChecked}` : ''}`;
}
