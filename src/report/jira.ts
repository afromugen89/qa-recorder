import { fixHint } from '../audit/a11y.js';
import { reportScreenshots, type BugReport, type ReportApiCall } from './bug.js';

// Jira-ready copy of a bug report. The report is first described as plain
// blocks, then written two ways:
// - Jira wiki markup, for Jira Server / Data Center text mode and jira.txt;
// - simple HTML, which Jira Cloud's editor turns into headings, lists and tables.
// The "Copy for Jira" buttons put both on the clipboard, so either kind of Jira
// picks the one it understands. Screenshots cannot be pasted, so they are
// copied into an attachments folder and named in the text.

type Inline = string | { b: string } | { i: string } | { code: string };
type Line = Inline[];
type Block =
  | { h: string }
  | { p: Line }
  | { ul: Line[] }
  | { ol: Line[] }
  | { table: { head: string[]; rows: Line[][] } }
  | { pre: string }
  | { image: string; caption: string };

/** A screenshot to attach to the Jira ticket. */
export interface JiraAttachment {
  /** Path relative to the session folder. */
  source: string;
  /** File name in the bug's attachments folder (and in the Jira text). */
  name: string;
  caption: string;
}

export interface JiraCopy {
  /** For Jira's Summary field. */
  summary: string;
  /** Description in Jira wiki markup. */
  wiki: string;
  /** Description as simple HTML, for pasting as rich text. */
  html: string;
  attachments: JiraAttachment[];
}

/** Every screenshot the report keeps, with a short, readable file name. */
export function jiraAttachments(r: BugReport): JiraAttachment[] {
  const out: JiraAttachment[] = [];
  const used = new Set<string>();
  const add = (source: string, base: string, caption: string) => {
    let name = `${base}.png`;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}.png`;
    used.add(name);
    out.push({ source, name, caption });
  };
  if (r.screenshot) add(r.screenshot, 'bug-screenshot', 'When the bug was reported');
  for (const s of reportScreenshots(r)) {
    const step = r.steps.find((x) => x.key === s.step);
    if (step) add(s.path, `step-${String(step.number).padStart(2, '0')}`, s.label);
    else if (/^Accessibility/.test(s.label)) add(s.path, 'accessibility', s.label);
    else add(s.path, `layout-${(s.label.match(/\d+×\d+/)?.[0] ?? 'view').replace('×', 'x')}`, s.label);
  }
  return out;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

function callStatus(c: ReportApiCall): string {
  const status = c.failure ? `failed: ${c.failure}` : `${c.status ?? ''} ${c.statusText ?? ''}`.trim();
  return c.mock ? `${status} (mocked: ${c.mock})` : status;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text);

function blocks(r: BugReport, attachments: JiraAttachment[]): Block[] {
  const out: Block[] = [];
  const facts: Line = [];
  const fact = (label: string, value?: string) => {
    if (!value) return;
    if (facts.length) facts.push('\n');
    facts.push({ b: `${label}:` }, ` ${value}`);
  };
  fact('Severity', r.severity);
  fact('Priority', r.priority);
  fact('Test technique (ISTQB)', r.techniques.map((t) => t.name).join(', '));
  fact('Reporter', r.reporter);
  out.push({ p: facts });
  if (r.mocks.length) {
    const calls = r.mocks.reduce((sum, m) => sum + m.calls, 0);
    out.push({ p: [{ b: 'Warning:' }, ` API mocks were active: ${calls} call${calls > 1 ? 's were' : ' was'} changed by ${r.mocks.map((m) => `"${m.rule}"`).join(', ')}. Check whether the bug also happens without them.`] });
  }

  out.push({ h: 'Environment' });
  const env: Line[] = [['URL: ', r.environment.url ?? 'n/a'], ['Browser: ', r.environment.browser]];
  if (r.environment.userAgent) env.push(['User agent: ', { code: r.environment.userAgent }]);
  if (r.environment.device) env.push(['Device emulation: ', r.environment.device]);
  const v = r.environment.viewport;
  if (v) env.push(['Viewport: ', `${v.width}×${v.height}${v.label ? ` (${v.label})` : ''}`]);
  out.push({ ul: env });

  out.push({ h: 'Steps to reproduce' });
  if (r.steps.length) out.push({ ol: r.steps.map((s) => (s.detail ? [s.text, '\n', { i: s.detail }] : [s.text])) });
  else out.push({ p: [{ i: 'No steps recorded.' }] });

  out.push({ h: 'Expected result' }, { p: [r.expected ?? 'Not stated.'] });
  out.push({ h: 'Actual result' }, { p: [r.actual] });

  out.push({ h: 'Test design technique (ISTQB)' });
  out.push({ ul: r.techniques.map((t) => [{ b: t.name }, `${t.reason ? `: ${t.reason}` : ''}${t.detected ? '' : ' (set by tester)'}`]) });

  const callTable = (list: ReportApiCall[]): Block => ({
    table: {
      head: ['Step', 'Request', 'Status', 'Time'],
      rows: list.map((c) => [[String(c.step ?? '')], [{ code: `${c.method} ${shortUrl(c.url)}` }], [callStatus(c)], [`${c.durationMs ?? '?'} ms`]]),
    },
  });
  if (r.failedApiCalls.length) {
    out.push({ h: 'Failed API calls' }, callTable(r.failedApiCalls));
    for (const c of r.failedApiCalls.slice(0, 5)) {
      if (!c.requestBody && !c.responseBody) continue;
      out.push({ p: [{ b: `${c.method} ${shortUrl(c.url)}` }] });
      if (c.requestBody) out.push({ p: ['Request body:'] }, { pre: clip(c.requestBody, 1500) });
      if (c.responseBody) out.push({ p: ['Response body:'] }, { pre: clip(c.responseBody, 1500) });
    }
  }
  if (r.slowApiCalls.length) out.push({ h: `Slow API calls (over ${r.slowThresholdMs} ms)` }, callTable(r.slowApiCalls));

  if (r.pageErrors.length || r.consoleErrors.length) {
    out.push({ h: 'Console and JavaScript errors' });
    out.push({
      ul: [
        ...r.pageErrors.map((e): Line => [{ b: 'Uncaught error' }, `${e.step ? ` (step ${e.step})` : ''}: ${e.message}`]),
        ...r.consoleErrors.map((e): Line => [
          { b: `Console ${e.level}` }, `${e.step ? ` (step ${e.step})` : ''}: ${e.text.slice(0, 500).replace(/\s+/g, ' ')}`,
          ...(e.location ? [' ', { code: e.location }] : []),
        ]),
      ],
    });
  }

  if (r.apiPerformance.length) {
    out.push({ h: 'API response times' }, {
      table: {
        head: ['Endpoint', 'Calls', 'Errors', 'Avg', 'p95', 'Max'],
        rows: r.apiPerformance.map((p) => [[{ code: p.endpoint }], [String(p.calls)], [String(p.errors)], [`${p.avgMs} ms`], [`${p.p95Ms} ms`], [`${p.maxMs} ms`]]),
      },
    });
  }

  for (const scan of r.accessibility) {
    out.push({ h: `Accessibility: ${scan.standard}` });
    out.push({ p: [`Checked ${scan.url}${scan.step ? ` at step ${scan.step}` : ''} with ${scan.engine}. `, { b: `${scan.summary}.` }, ` ${scan.passes} rules passed, ${scan.needsReview.length} need review.`] });
    if (scan.violations.length) {
      out.push({
        table: {
          head: ['#', 'Issue', 'Impact', 'WCAG', 'Elements', 'Example'],
          rows: scan.violations.map((x, i) => [
            [String(i + 1)], [`${x.help} (${x.id})`], [x.impact ?? ''],
            [x.wcag.length ? `${x.wcag.join(', ')} (${x.level})` : 'best practice'], [String(x.nodeCount)],
            x.nodes[0] ? [{ code: x.nodes[0].selector }] : [''],
          ]),
        },
      });
      for (const [i, x] of scan.violations.entries()) {
        const first = x.nodes[0];
        if (first?.summary) out.push({ p: [{ b: `${i + 1}. How to fix:` }, ` ${fixHint(first.summary).replace(/\s+/g, ' ')} (${x.helpUrl})`] });
      }
    }
    if (scan.needsReview.length) out.push({ p: [`Needs a manual check: ${scan.needsReview.map((n) => `${n.help} (${n.nodeCount})`).join('; ')}`] });
  }

  for (const check of r.layout) {
    out.push({ h: 'Responsive layout' });
    out.push({ p: [`Checked ${check.url}${check.step ? ` at step ${check.step}` : ''}. `, { b: `${check.summary}.` }] });
    out.push({
      table: {
        head: ['Size', 'Errors', 'Warnings'],
        rows: check.viewports.map((vp) => {
          const e = vp.issues.filter((i) => i.severity === 'error').length;
          const w = vp.issues.filter((i) => i.severity === 'warning').length;
          return [[`${vp.label} ${vp.width}×${vp.height}`], [vp.error ? `not checked: ${vp.error}` : String(e)], [vp.error ? '' : String(w)]];
        }),
      },
    });
    const issues = check.viewports.flatMap((vp) =>
      vp.issues.map((i): Line => [`${vp.width}×${vp.height}: `, ...(i.severity === 'error' ? [{ b: 'Error:' }, ' '] : ['Warning: ']), i.message]));
    if (issues.length) out.push({ ul: issues });
  }

  if (r.mocks.length) {
    out.push({ h: 'API mocks used' });
    out.push({ ul: r.mocks.map((m) => [{ b: m.rule }, ` (${m.calls} call${m.calls > 1 ? 's' : ''}): ${m.changes.slice(0, 8).join('; ') || 'no changes'}`]) });
  }

  if (r.notes) out.push({ h: 'Notes' }, { p: [r.notes] });

  if (attachments.length) {
    out.push({ h: 'Screenshots' });
    for (const a of attachments) out.push({ image: a.name, caption: a.caption });
  }
  return out;
}

// ---------- Jira wiki markup ----------

/** Escapes the characters Jira wiki markup would treat as formatting. URLs are left alone. */
function wikiText(text: string): string {
  return text
    .split(/(https?:\/\/\S+)/)
    .map((part, i) => (i % 2 ? part : part.replace(/[{}[\]|!*_^~\\]/g, (c) => (c === '\\' ? '&#92;' : `\\${c}`))))
    .join('');
}

function wikiInline(line: Line, newline = '\n'): string {
  return line
    .map((x) => {
      if (typeof x === 'string') return wikiText(x).replace(/\r?\n/g, newline);
      if ('b' in x) return `*${wikiText(x.b)}*`;
      if ('i' in x) return `_${wikiText(x.i)}_`;
      return `{{${wikiText(x.code)}}}`;
    })
    .join('');
}

export function toWiki(list: Block[]): string {
  const out: string[] = [];
  for (const b of list) {
    if ('h' in b) out.push(`h3. ${wikiText(b.h)}`);
    else if ('p' in b) out.push(wikiInline(b.p));
    else if ('ul' in b) out.push(b.ul.map((l) => `* ${wikiInline(l, ' \\\\ ')}`).join('\n'));
    else if ('ol' in b) out.push(b.ol.map((l) => `# ${wikiInline(l, ' \\\\ ')}`).join('\n'));
    else if ('table' in b) {
      out.push([
        `||${b.table.head.map(wikiText).join('||')}||`,
        ...b.table.rows.map((row) => `|${row.map((cell) => wikiInline(cell, ' ') || ' ').join('|')}|`),
      ].join('\n'));
    } else if ('pre' in b) out.push(`{noformat}\n${b.pre.replace(/\{noformat\}/g, '{ noformat }')}\n{noformat}`);
    else out.push(`!${b.image}|thumbnail!\n${wikiText(b.caption)}`);
  }
  return `${out.join('\n\n')}\n`;
}

// ---------- simple HTML ----------

const esc = (text: unknown) =>
  String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function htmlInline(line: Line): string {
  return line
    .map((x) => {
      if (typeof x === 'string') return esc(x).replace(/\r?\n/g, '<br>');
      if ('b' in x) return `<strong>${esc(x.b)}</strong>`;
      if ('i' in x) return `<em>${esc(x.i)}</em>`;
      return `<code>${esc(x.code)}</code>`;
    })
    .join('');
}

export function toHtml(list: Block[]): string {
  return list
    .map((b) => {
      if ('h' in b) return `<h3>${esc(b.h)}</h3>`;
      if ('p' in b) return `<p>${htmlInline(b.p)}</p>`;
      if ('ul' in b) return `<ul>${b.ul.map((l) => `<li>${htmlInline(l)}</li>`).join('')}</ul>`;
      if ('ol' in b) return `<ol>${b.ol.map((l) => `<li>${htmlInline(l)}</li>`).join('')}</ol>`;
      if ('table' in b) {
        return `<table><thead><tr>${b.table.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${b.table.rows
          .map((row) => `<tr>${row.map((cell) => `<td>${htmlInline(cell)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`;
      }
      if ('pre' in b) return `<pre>${esc(b.pre)}</pre>`;
      return `<p>${esc(b.caption)}: see attachment <code>${esc(b.image)}</code></p>`;
    })
    .join('\n');
}

/** The report as Jira text: summary, description (wiki and HTML) and the files to attach. */
export function jiraCopy(r: BugReport): JiraCopy {
  const attachments = jiraAttachments(r);
  const list = blocks(r, attachments);
  return { summary: r.title, wiki: toWiki(list), html: toHtml(list), attachments };
}
