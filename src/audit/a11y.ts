import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from 'playwright';
import { ensureAuditScript } from './layout.js';

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const AXE_VERSION = (require('axe-core/package.json') as { version: string }).version;

export type WcagVersion = '2.0' | '2.1' | '2.2';
export type WcagLevel = 'A' | 'AA' | 'AAA';
export type Impact = 'minor' | 'moderate' | 'serious' | 'critical';

export interface A11yOptions {
  /** WCAG version to check against. Default 2.2. */
  version?: WcagVersion;
  /** Conformance level. Default AA. */
  level?: WcagLevel;
  /** Also run axe-core's best-practice rules, which are not WCAG failures. Default false. */
  bestPractices?: boolean;
  /** Check inside iframes too. Default true. */
  iframes?: boolean;
}

export interface A11yNode {
  /** axe-core target: one selector per frame; an array of selectors steps into shadow DOM. */
  target: (string | string[])[];
  /** Readable form of the target. */
  selector: string;
  html: string;
  /** How to fix it, from axe-core. */
  summary?: string;
}

export interface A11yRule {
  id: string;
  impact?: Impact;
  help: string;
  description: string;
  helpUrl: string;
  /** WCAG success criteria, e.g. ["1.4.3"]. Empty for best-practice rules. */
  wcag: string[];
  /** Lowest WCAG level the rule belongs to, or "best practice". */
  level: WcagLevel | 'best practice';
  /** Up to 20 affected elements. */
  nodes: A11yNode[];
  /** How many elements are affected in total. */
  nodeCount: number;
}

export interface A11yResult {
  /** e.g. "WCAG 2.2 AA". */
  standard: string;
  options: Required<A11yOptions>;
  engine: string;
  url: string;
  /** Rules that failed. */
  violations: A11yRule[];
  /** Rules axe-core could not decide; a person has to check these. */
  needsReview: A11yRule[];
  passes: number;
  /** Failed elements by impact. */
  byImpact: Record<Impact, number>;
}

const IMPACT_ORDER: Impact[] = ['critical', 'serious', 'moderate', 'minor'];
const MAX_NODES = 20;

export function describeStandard(options: A11yOptions): string {
  const o = withDefaults(options);
  return `WCAG ${o.version} ${o.level}${o.bestPractices ? ' + best practices' : ''}`;
}

function withDefaults(options: A11yOptions = {}): Required<A11yOptions> {
  return { version: '2.2', level: 'AA', bestPractices: false, iframes: true, ...options };
}

/** axe-core tags for a WCAG version and level. Each version includes the ones before it. */
export function wcagTags(version: WcagVersion = '2.2', level: WcagLevel = 'AA', bestPractices = false): string[] {
  const levels = level === 'A' ? ['a'] : level === 'AA' ? ['a', 'aa'] : ['a', 'aa', 'aaa'];
  const versions = version === '2.0' ? ['2'] : version === '2.1' ? ['2', '21'] : ['2', '21', '22'];
  const tags = versions.flatMap((v) => levels.map((l) => `wcag${v}${l}`));
  if (bestPractices) tags.push('best-practice');
  return tags;
}

/** "wcag1412" → "1.4.12". */
export function criterionFromTag(tag: string): string | undefined {
  const m = /^wcag(\d)(\d)(\d+)$/.exec(tag);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : undefined;
}

function levelFromTags(tags: string[]): A11yRule['level'] {
  const levels = tags.map((t) => /^wcag2\d?(a{1,3})$/.exec(t)?.[1]).filter(Boolean) as string[];
  if (!levels.length) return 'best practice';
  const shortest = levels.sort((a, b) => a.length - b.length)[0];
  return shortest.toUpperCase() as WcagLevel;
}

export function targetText(target: (string | string[])[]): string {
  return target.map((part) => (Array.isArray(part) ? part.join(' >>> ') : part)).join(' >> ');
}

/** The first one or two fixes from an axe-core failure summary, on one line. */
export function fixHint(summary: string | undefined, max = 2): string {
  if (!summary) return '';
  const lines = summary.split('\n').map((l) => l.trim()).filter((l) => l && !/^Fix (any|all) of the following:?$/i.test(l));
  return lines.slice(0, max).join('; ') + (lines.length > max ? '; …' : '');
}

interface RawRule {
  id: string;
  impact?: Impact | null;
  help: string;
  description: string;
  helpUrl: string;
  tags: string[];
  nodes: { target: (string | string[])[]; html: string; failureSummary?: string }[];
}

function toRule(raw: RawRule): A11yRule {
  return {
    id: raw.id,
    ...(raw.impact && { impact: raw.impact }),
    help: raw.help,
    description: raw.description,
    helpUrl: raw.helpUrl,
    wcag: raw.tags.map(criterionFromTag).filter((c): c is string => Boolean(c)),
    level: levelFromTags(raw.tags),
    nodes: raw.nodes.slice(0, MAX_NODES).map((n) => ({
      target: n.target,
      selector: targetText(n.target),
      html: n.html.length > 300 ? `${n.html.slice(0, 300)}…` : n.html,
      ...(n.failureSummary && { summary: n.failureSummary }),
    })),
    nodeCount: raw.nodes.length,
  };
}

const byImpact = (a: A11yRule, b: A11yRule) =>
  IMPACT_ORDER.indexOf(a.impact ?? 'minor') - IMPACT_ORDER.indexOf(b.impact ?? 'minor') || b.nodeCount - a.nodeCount;

/** Puts axe-core into every frame of the page (including cross-origin iframes). */
async function injectAxe(page: Page): Promise<void> {
  const script = `if (!window.axe) { ${AXE_SOURCE}\n } window.axe.configure({ allowedOrigins: ['<unsafe_all_origins>'] }); true`;
  await Promise.all(page.frames().map((frame) => frame.evaluate(script).catch(() => undefined)));
}

/**
 * Runs an axe-core accessibility scan of the page as it is now, against the
 * chosen WCAG version and level. The QA panel and its overlays are excluded.
 */
export async function runA11yScan(page: Page, options: A11yOptions = {}): Promise<A11yResult> {
  const o = withDefaults(options);
  await injectAxe(page);
  const tags = wcagTags(o.version, o.level, o.bestPractices);
  await ensureAuditScript(page);
  const raw = await page.mainFrame().evaluate(
    (args) => (window as unknown as { __qaAudit: { runAxe(a: unknown): Promise<{ url: string; violations: RawRule[]; incomplete: RawRule[]; passes: number }> } })
      .__qaAudit.runAxe(args),
    { tags, iframes: o.iframes },
  );
  const violations = (raw.violations as RawRule[]).map(toRule).sort(byImpact);
  const counts: Record<Impact, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of violations) counts[v.impact ?? 'minor'] += v.nodeCount;
  return {
    standard: describeStandard(o),
    options: o,
    engine: `axe-core ${AXE_VERSION}`,
    url: raw.url,
    violations,
    needsReview: (raw.incomplete as RawRule[]).map(toRule).sort(byImpact),
    passes: raw.passes,
    byImpact: counts,
  };
}

/** One line, e.g. "5 rules failed on 12 elements (2 critical, 3 serious)". */
export function a11ySummary(r: Pick<A11yResult, 'violations' | 'byImpact'>): string {
  if (!r.violations.length) return 'No violations found';
  const elements = r.violations.reduce((sum, v) => sum + v.nodeCount, 0);
  const impacts = IMPACT_ORDER.filter((i) => r.byImpact[i]).map((i) => `${r.byImpact[i]} ${i}`).join(', ');
  return `${r.violations.length} rule${r.violations.length > 1 ? 's' : ''} failed on ${elements} element${elements > 1 ? 's' : ''}${impacts ? ` (${impacts})` : ''}`;
}
