import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { a11ySummary, describeStandard, runA11yScan, type A11yOptions, type A11yResult } from './a11y.js';
import {
  annotatedScreenshot, boundaryWidths, DEFAULT_PRESETS, detectBreakpoints, ensureAuditScript, layoutSummary, runLayoutCheck,
  VIEWPORT_PRESETS, type LayoutRequest,
} from './layout.js';
import type { A11yEvent, LayoutEvent, ViewportEvent } from '../recorder/types.js';

/** What AuditService needs from the recorder. */
export interface AuditHost {
  sessionDir: string;
  executablePath?: string;
  /** CSS for evidence screenshots: hides the QA panel. */
  screenshotStyle: string;
  /** The seq the next event will get, for file names. */
  nextSeq(): number;
  pageIdOf(page: Page): number;
  pushA11y(event: Omit<A11yEvent, 'seq' | 'timestamp' | 'elapsedMs' | 'type'>): A11yEvent;
  pushLayout(event: Omit<LayoutEvent, 'seq' | 'timestamp' | 'elapsedMs' | 'type'>): LayoutEvent;
  pushViewport(event: Omit<ViewportEvent, 'seq' | 'timestamp' | 'elapsedMs' | 'type'>): ViewportEvent;
}

const IMPACT_COLORS: Record<string, string> = { critical: '#b91c1c', serious: '#dc2626', moderate: '#d97706', minor: '#2563eb' };

/**
 * Backs the panel's Accessibility and Responsive tabs: axe-core scans,
 * multi-size layout checks, CSS breakpoint detection and resizing the tab.
 * Each check is recorded on the timeline so bug reports include it.
 */
export class AuditService {
  private checkBrowser?: Promise<Browser>;
  /** Size of each tab before the QA first resized it. */
  private originalSizes = new WeakMap<Page, { width: number; height: number }>();

  constructor(private readonly host: AuditHost) {}

  static readonly COMMANDS = new Set(['auditInit', 'a11yScan', 'a11yShow', 'layoutCheck', 'breakpoints', 'resize']);

  async handle(page: Page, command: { cmd: string; [key: string]: unknown }): Promise<unknown> {
    try {
      return { ok: true, result: await this.dispatch(page, command) };
    } catch (error) {
      return { ok: false, error: (error as Error).message.split('\n')[0] };
    }
  }

  private async dispatch(page: Page, c: { cmd: string; [key: string]: unknown }): Promise<unknown> {
    switch (c.cmd) {
      case 'auditInit':
        return {
          presets: VIEWPORT_PRESETS,
          defaults: DEFAULT_PRESETS,
          resized: this.originalSizes.has(page),
        };
      case 'a11yScan':
        return this.a11y(page, (c.options ?? {}) as A11yOptions);
      case 'a11yShow':
        await ensureAuditScript(page);
        return page.mainFrame().evaluate(
          async ({ target, label }) => {
            const w = window as unknown as { __qaAudit?: { highlight(t: unknown, l: string): boolean } };
            return w.__qaAudit ? w.__qaAudit.highlight(target, label) : false;
          },
          { target: c.target, label: String(c.label ?? '') },
        );
      case 'layoutCheck':
        return this.layout(page, (c.request ?? {}) as LayoutRequest);
      case 'breakpoints': {
        const { breakpoints, unreadable } = await detectBreakpoints(page);
        return { breakpoints, boundaries: boundaryWidths(breakpoints), unreadable };
      }
      case 'resize':
        return this.resize(page, c);
      default:
        throw new Error(`Unknown command ${c.cmd}`);
    }
  }

  /** Scans the tab as it is now and records the result. */
  async a11y(page: Page, options: A11yOptions = {}): Promise<{ result: A11yResult; summary: string; screenshot?: string; seq: number }> {
    const result = await runA11yScan(page, options);
    const file = `screenshots/a11y-${String(this.host.nextSeq()).padStart(4, '0')}.png`;
    let screenshot: string | undefined = file;
    try {
      const items = result.violations.flatMap((v, i) =>
        v.nodes.slice(0, 10).map((n) => ({ target: n.target, label: String(i + 1), color: IMPACT_COLORS[v.impact ?? 'minor'] })));
      await ensureAuditScript(page);
      const boxes = await page.mainFrame().evaluate(
        (list) => (window as unknown as { __qaAudit: { boxesFor(l: unknown): unknown[] } }).__qaAudit.boxesFor(list),
        items.slice(0, 80),
      ).catch(() => []);
      await annotatedScreenshot(page, boxes as never, join(this.host.sessionDir, file), { style: this.host.screenshotStyle });
    } catch {
      screenshot = undefined;
    }
    const event = this.host.pushA11y({ pageId: this.host.pageIdOf(page), url: result.url, result, ...(screenshot && { screenshot }) });
    return { result, summary: `${describeStandard(result.options)}: ${a11ySummary(result)}`, screenshot, seq: event.seq };
  }

  /** Checks the layout at several sizes and records the result. */
  async layout(page: Page, request: LayoutRequest) {
    const result = await runLayoutCheck(page, request, {
      sessionDir: this.host.sessionDir,
      screenshotPrefix: `screenshots/layout-${String(this.host.nextSeq()).padStart(4, '0')}`,
      browser: () => this.browser(),
      style: this.host.screenshotStyle,
    });
    const event = this.host.pushLayout({ pageId: this.host.pageIdOf(page), url: result.url, result });
    return { result, summary: layoutSummary(result), seq: event.seq };
  }

  private async resize(page: Page, c: { [key: string]: unknown }) {
    if (c.reset) {
      const original = this.originalSizes.get(page);
      if (!original) return { resized: false };
      await page.setViewportSize(original);
      this.originalSizes.delete(page);
      this.host.pushViewport({ pageId: this.host.pageIdOf(page), ...original, reset: true });
      return { resized: false, ...original };
    }
    const preset = c.preset ? VIEWPORT_PRESETS.find((p) => p.id === c.preset) : undefined;
    if (c.preset && !preset) throw new Error(`Unknown viewport "${c.preset}"`);
    const width = Math.round(Number(preset?.width ?? c.width));
    const height = Math.round(Number(preset?.height ?? c.height ?? 800));
    if (!Number.isFinite(width) || width < 200 || width > 4000) throw new Error('Width must be between 200 and 4000 px');
    if (!Number.isFinite(height) || height < 200 || height > 4000) throw new Error('Height must be between 200 and 4000 px');
    if (!this.originalSizes.has(page)) {
      const current = page.viewportSize() ?? (await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })));
      this.originalSizes.set(page, current);
    }
    await page.setViewportSize({ width, height });
    this.host.pushViewport({ pageId: this.host.pageIdOf(page), width, height, ...(preset && { label: preset.name }) });
    return { resized: true, width, height, label: preset?.name };
  }

  /** A separate headless browser for loading pages at other sizes, so the recorded tab stays as it is. */
  private browser(): Promise<Browser> {
    this.checkBrowser ??= chromium.launch({ headless: true, executablePath: this.host.executablePath });
    return this.checkBrowser;
  }

  async close(): Promise<void> {
    if (!this.checkBrowser) return;
    const browser = await this.checkBrowser.catch(() => undefined);
    this.checkBrowser = undefined;
    await browser?.close().catch(() => undefined);
  }
}
