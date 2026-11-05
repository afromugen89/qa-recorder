import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fixHint } from '../audit/a11y.js';
import { buildBugReport, type BugInput, type BugReport, type ReportApiCall, type ReportA11yScan, type ReportLayoutCheck } from './bug.js';
import { jiraCopy, type JiraCopy } from './jira.js';
import type { SessionData } from '../recorder/types.js';

// ---------- Markdown (paste into Jira, GitHub, Azure DevOps) ----------

const mdCell = (text: string | number | undefined) => String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function mdCode(text: string, max = 1500): string {
  const body = text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
  return '```\n' + body.replace(/```/g, "'''") + '\n```';
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

function mockWarning(r: BugReport): string | undefined {
  if (!r.mocks.length) return undefined;
  const calls = r.mocks.reduce((sum, m) => sum + m.calls, 0);
  return `API mocks were active: ${calls} call${calls > 1 ? 's were' : ' was'} changed by ${r.mocks.map((m) => `"${m.rule}"`).join(', ')}. Check whether the bug also happens without them.`;
}

/** `imageBase` is the path from the Markdown file to the session folder. */
export function renderMarkdown(r: BugReport, imageBase = '.'): string {
  const out: string[] = [];
  out.push(`# ${r.title}`, '');
  const facts = [
    r.severity && `**Severity:** ${r.severity}`,
    r.priority && `**Priority:** ${r.priority}`,
    `**Test technique (ISTQB):** ${r.techniques.map((t) => t.name).join(', ')}`,
    r.reporter && `**Reporter:** ${r.reporter}`,
  ].filter(Boolean);
  out.push(facts.join('  \n'), '');
  const warning = mockWarning(r);
  if (warning) out.push(`> ⚠️ ${warning}`, '');

  out.push('## Environment', '');
  out.push(`- URL: ${r.environment.url ?? 'n/a'}`);
  out.push(`- Browser: ${r.environment.browser}`);
  if (r.environment.userAgent) out.push(`- User agent: \`${r.environment.userAgent}\``);
  if (r.environment.device) out.push(`- Device emulation: ${r.environment.device}`);
  if (r.environment.viewport) out.push(`- Viewport: ${viewportText(r.environment.viewport)}`);
  out.push('');

  out.push('## Steps to reproduce', '');
  for (const s of r.steps) {
    out.push(`${s.number}. ${s.text}${s.detail ? `  \n   _${s.detail}_` : ''}`);
  }
  if (!r.steps.length) out.push('_No steps recorded._');
  out.push('');

  out.push('## Expected result', '', r.expected ?? '_Not stated._', '');
  out.push('## Actual result', '', r.actual, '');

  out.push('## Test design technique (ISTQB)', '');
  for (const t of r.techniques) {
    out.push(`- **${t.name}**${t.reason ? `: ${t.reason}` : ''}${t.detected ? '' : ' (set by tester)'}`);
  }
  out.push('');

  if (r.failedApiCalls.length) {
    out.push('## Failed API calls', '');
    out.push('| Step | Method | URL | Status | Time |', '| --- | --- | --- | --- | --- |');
    for (const c of r.failedApiCalls) {
      out.push(`| ${c.step ?? ''} | ${c.method} | ${mdCell(shortUrl(c.url))} | ${mdCell(callStatus(c))} | ${c.durationMs ?? '?'} ms |`);
    }
    out.push('');
    for (const c of r.failedApiCalls.slice(0, 5)) {
      if (!c.requestBody && !c.responseBody) continue;
      out.push(`**${c.method} ${shortUrl(c.url)}**`, '');
      if (c.requestBody) out.push('Request body:', mdCode(c.requestBody), '');
      if (c.responseBody) out.push('Response body:', mdCode(c.responseBody), '');
    }
  }

  if (r.slowApiCalls.length) {
    out.push(`## Slow API calls (over ${r.slowThresholdMs} ms)`, '');
    out.push('| Step | Method | URL | Status | Time |', '| --- | --- | --- | --- | --- |');
    for (const c of r.slowApiCalls) {
      out.push(`| ${c.step ?? ''} | ${c.method} | ${mdCell(shortUrl(c.url))} | ${mdCell(callStatus(c))} | ${c.durationMs} ms |`);
    }
    out.push('');
  }

  if (r.pageErrors.length || r.consoleErrors.length) {
    out.push('## Console and JavaScript errors', '');
    for (const e of r.pageErrors) out.push(`- **Uncaught error**${e.step ? ` (step ${e.step})` : ''}: ${e.message}`);
    for (const e of r.consoleErrors) {
      out.push(`- **Console ${e.level}**${e.step ? ` (step ${e.step})` : ''}: ${mdCell(e.text.slice(0, 500))}${e.location ? ` \`${e.location}\`` : ''}`);
    }
    out.push('');
  }

  if (r.apiPerformance.length) {
    out.push('## API response times', '');
    out.push('| Endpoint | Calls | Errors | Avg | p95 | Max |', '| --- | --- | --- | --- | --- | --- |');
    for (const p of r.apiPerformance) {
      out.push(`| ${mdCell(p.endpoint)} | ${p.calls} | ${p.errors} | ${p.avgMs} ms | ${p.p95Ms} ms | ${p.maxMs} ms |`);
    }
    out.push('');
  }

  for (const scan of r.accessibility) out.push(...mdA11y(scan, imageBase));
  for (const check of r.layout) out.push(...mdLayout(check, imageBase));

  if (r.mocks.length) {
    out.push('## API mocks used', '');
    for (const m of r.mocks) {
      out.push(`- **${m.rule}** (${m.calls} call${m.calls > 1 ? 's' : ''}): ${m.changes.slice(0, 8).join('; ') || 'no changes'}`);
    }
    out.push('');
  }

  if (r.notes) out.push('## Notes', '', r.notes, '');

  const shots = r.steps.filter((s) => s.screenshot);
  if (r.screenshot || shots.length) {
    out.push('## Screenshots', '');
    if (r.screenshot) out.push(`When the bug was reported:`, '', `![Bug](${imageBase}/${r.screenshot})`, '');
    for (const s of shots) out.push(`After step ${s.number}:`, '', `![Step ${s.number}](${imageBase}/${s.screenshot})`, '');
  }

  out.push('## Attachments', '', `- Full network log: \`${imageBase}/network.har\``, '');
  out.push('---', '_Generated by qa-recorder_', '');
  return out.join('\n');
}

function viewportText(v: { width: number; height: number; label?: string }): string {
  return `${v.width}×${v.height}${v.label ? ` (${v.label})` : ''}`;
}

const A11Y_NOTE = 'Automated checks cannot cover every WCAG success criterion. Keyboard-only use, screen reader output and the "needs review" items still need a manual check.';

function mdA11y(scan: ReportA11yScan, imageBase: string): string[] {
  const out = [`## Accessibility: ${scan.standard}`, ''];
  out.push(`Checked ${scan.url}${scan.step ? ` at step ${scan.step}` : ''} with ${scan.engine}. **${scan.summary}.** ${scan.passes} rules passed, ${scan.needsReview.length} need review.`, '');
  out.push('_ISTQB: non-functional (accessibility) testing, checklist-based._', '');
  if (scan.violations.length) {
    out.push('| # | Issue | Impact | WCAG | Elements | Example |', '| --- | --- | --- | --- | --- | --- |');
    scan.violations.forEach((v, i) => {
      const example = v.nodes[0] ? `\`${mdCell(v.nodes[0].selector)}\`` : '';
      out.push(`| ${i + 1} | ${mdCell(v.help)} (\`${v.id}\`) | ${v.impact ?? ''} | ${v.wcag.length ? `${v.wcag.join(', ')} (${v.level})` : 'best practice'} | ${v.nodeCount} | ${example} |`);
    });
    out.push('');
    for (const [i, v] of scan.violations.entries()) {
      out.push(`**${i + 1}. ${v.help}** ([how to fix](${v.helpUrl}))`, '');
      for (const n of v.nodes.slice(0, 5)) out.push(`- \`${mdCell(n.selector)}\`${n.summary ? `: ${mdCell(fixHint(n.summary))}` : ''}`);
      if (v.nodeCount > 5) out.push(`- …and ${v.nodeCount - 5} more`);
      out.push('');
    }
  }
  if (scan.needsReview.length) {
    out.push(`Needs a manual check: ${scan.needsReview.map((n) => `${n.help} (${n.nodeCount})`).join('; ')}`, '');
  }
  out.push(`_${A11Y_NOTE}_`, '');
  if (scan.screenshot) out.push(`![Accessibility issues outlined](${imageBase}/${scan.screenshot})`, '');
  return out;
}

function sizeLabel(v: ReportLayoutCheck['viewports'][number]): string {
  return v.fresh ? `${v.label}${v.label.includes(String(v.width)) ? '' : ` ${v.width}×${v.height}`}` : v.label;
}

function mdLayout(check: ReportLayoutCheck, imageBase: string): string[] {
  const out = ['## Responsive layout', ''];
  out.push(`Checked ${check.url}${check.step ? ` at step ${check.step}` : ''}. **${check.summary}.**`, '');
  out.push('_ISTQB: non-functional (portability / usability) testing, checklist-based; breakpoint widths use boundary value analysis._', '');
  out.push('| Size | Mobile checks | Errors | Warnings |', '| --- | --- | --- | --- |');
  for (const v of check.viewports) {
    const e = v.issues.filter((i) => i.severity === 'error').length;
    const w = v.issues.filter((i) => i.severity === 'warning').length;
    out.push(`| ${mdCell(sizeLabel(v))} | ${v.isMobile || v.width <= 767 ? 'yes' : 'no'} | ${v.error ? `not checked: ${mdCell(v.error)}` : e} | ${v.error ? '' : w} |`);
  }
  out.push('');
  for (const v of check.viewports) {
    if (!v.issues.length) continue;
    out.push(`**${sizeLabel(v)}**`, '');
    for (const i of v.issues) out.push(`- ${i.marker ? `[${i.marker}] ` : ''}${i.severity === 'error' ? '**Error:**' : 'Warning:'} ${mdCell(i.message)}`);
    out.push('');
    if (v.screenshot) out.push(`![${sizeLabel(v)}](${imageBase}/${v.screenshot})`, '');
  }
  return out;
}

// ---------- HTML (self-contained, screenshots embedded) ----------

const esc = (text: unknown) =>
  String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function image(sessionDir: string, file: string | undefined, alt: string): string {
  if (!file) return '';
  const path = join(sessionDir, file);
  if (!existsSync(path)) return '';
  const data = readFileSync(path).toString('base64');
  return `<img alt="${esc(alt)}" src="data:image/png;base64,${data}" class="zoom" tabindex="0" role="button" title="Click to see it at full size">`;
}

const IMPACT_CLASS: Record<string, string> = { critical: 'bad', serious: 'bad', moderate: 'warn', minor: '' };

function htmlA11y(scan: ReportA11yScan, sessionDir: string): string {
  return `<h2>Accessibility: ${esc(scan.standard)}</h2>
  <p>Checked <code>${esc(scan.url)}</code>${scan.step ? ` at step ${scan.step}` : ''} with ${esc(scan.engine)}. <b>${esc(scan.summary)}.</b> ${scan.passes} rules passed, ${scan.needsReview.length} need review.</p>
  <p class="meta">ISTQB: non-functional (accessibility) testing, checklist-based.</p>
  ${scan.violations.length ? `<div class="wrap"><table><thead><tr><th>#</th><th>Issue</th><th>Impact</th><th>WCAG</th><th>Elements</th></tr></thead><tbody>
    ${scan.violations.map((v, i) => `<tr class="${IMPACT_CLASS[v.impact ?? 'minor']}"><td>${i + 1}</td><td><b>${esc(v.help)}</b> <span class="tag">${esc(v.id)}</span>
      <div class="detail">${esc(v.description)} <a href="${esc(v.helpUrl)}">How to fix</a></div>
      <details><summary>${v.nodeCount} element${v.nodeCount > 1 ? 's' : ''}</summary>${v.nodes.map((n) => `<div style="margin:6px 0"><code>${esc(n.selector)}</code><pre>${esc(n.html)}</pre>${n.summary ? `<div class="detail">${esc(fixHint(n.summary, 4))}</div>` : ''}</div>`).join('')}${v.nodeCount > v.nodes.length ? `<div class="detail">…and ${v.nodeCount - v.nodes.length} more</div>` : ''}</details></td>
      <td>${esc(v.impact ?? '')}</td><td>${v.wcag.length ? `${esc(v.wcag.join(', '))} (${esc(v.level)})` : 'best practice'}</td><td>${v.nodeCount}</td></tr>`).join('')}
  </tbody></table></div>` : ''}
  ${scan.needsReview.length ? `<p><b>Needs a manual check:</b> ${esc(scan.needsReview.map((n) => `${n.help} (${n.nodeCount})`).join('; '))}</p>` : ''}
  <p class="meta">${esc(A11Y_NOTE)}</p>
  ${scan.screenshot ? `<figure>${image(sessionDir, scan.screenshot, 'Accessibility issues outlined')}<figcaption>Numbers match the table above.</figcaption></figure>` : ''}`;
}

function htmlLayout(check: ReportLayoutCheck, sessionDir: string): string {
  return `<h2>Responsive layout</h2>
  <p>Checked <code>${esc(check.url)}</code>${check.step ? ` at step ${check.step}` : ''}. <b>${esc(check.summary)}.</b></p>
  <p class="meta">ISTQB: non-functional (portability / usability) testing, checklist-based; breakpoint widths use boundary value analysis.</p>
  <div class="wrap"><table><thead><tr><th>Size</th><th>Issues</th></tr></thead><tbody>
  ${check.viewports.map((v) => {
    const errors = v.issues.filter((i) => i.severity === 'error').length;
    return `<tr class="${v.error || errors ? 'bad' : v.issues.length ? 'warn' : ''}"><td><b>${esc(sizeLabel(v))}</b>${v.fresh ? '' : '<div class="detail">kept the tab as it was</div>'}${v.boundary ? '<div class="detail">CSS breakpoint boundary</div>' : ''}</td><td>${v.error ? `Not checked: ${esc(v.error)}` : v.issues.length ? `<ul>${v.issues.map((i) => `<li>${i.marker ? `<span class="tag">${i.marker}</span> ` : ''}${i.severity === 'error' ? '<b>Error:</b> ' : ''}${esc(i.message)}</li>`).join('')}</ul>` : 'No issues'}</td></tr>`;
  }).join('')}
  </tbody></table></div>
  <div class="shots">${check.viewports.filter((v) => v.screenshot).map((v) => `<figure>${image(sessionDir, v.screenshot, sizeLabel(v))}<figcaption>${esc(sizeLabel(v))}</figcaption></figure>`).join('')}</div>`;
}

/** Copies to the clipboard and opens screenshots at full size. Plain browser script. */
const REPORT_SCRIPT = `
(() => {
  const status = document.getElementById('copy-status');
  function copy(text, html, what) {
    const onCopy = (e) => {
      e.clipboardData.setData('text/plain', text);
      if (html) e.clipboardData.setData('text/html', html);
      e.preventDefault();
    };
    document.addEventListener('copy', onCopy);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.removeEventListener('copy', onCopy);
    if (!ok && navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => { status.textContent = what + ' copied.'; }, () => { status.textContent = 'Copy failed. Use the Jira text below.'; });
      return;
    }
    status.textContent = ok ? what + ' copied.' : 'Copy failed. Use the Jira text below.';
  }
  const jiraText = document.getElementById('jira-wiki');
  const jiraHtml = document.getElementById('jira-html');
  document.getElementById('copy-jira').addEventListener('click', () =>
    copy(jiraText.value, jiraHtml.innerHTML, 'Description'));
  document.getElementById('copy-summary').addEventListener('click', () =>
    copy(document.querySelector('h1').textContent, '', 'Summary'));

  const box = document.getElementById('lightbox');
  const big = box.querySelector('img');
  const open = (img) => { big.src = img.src; big.alt = img.alt; box.hidden = false; box.focus(); };
  const close = () => { box.hidden = true; big.removeAttribute('src'); };
  for (const img of document.querySelectorAll('img.zoom')) {
    img.addEventListener('click', () => open(img));
    img.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(img); } });
  }
  box.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !box.hidden) close(); });
})();
`;

export function renderHtml(r: BugReport, sessionDir: string, jira: JiraCopy = jiraCopy(r)): string {
  const calls = (list: ReportApiCall[]) => `
    <table><thead><tr><th>Step</th><th>Request</th><th>Status</th><th>Time</th></tr></thead><tbody>
    ${list.map((c) => `<tr><td>${c.step ?? ''}</td><td><code>${esc(c.method)} ${esc(shortUrl(c.url))}</code>
      ${c.requestBody ? `<details><summary>Request body</summary><pre>${esc(c.requestBody)}</pre></details>` : ''}
      ${c.responseBody ? `<details open><summary>Response body</summary><pre>${esc(c.responseBody)}</pre></details>` : ''}</td>
      <td>${esc(callStatus(c))}</td><td>${c.durationMs ?? '?'} ms</td></tr>`).join('')}
    </tbody></table>`;

  const shots = r.steps.filter((s) => s.screenshot);
  const sev = r.severity ? `<span class="pill sev-${esc(r.severity)}">${esc(r.severity)}</span>` : '';
  const pri = r.priority ? `<span class="pill">priority ${esc(r.priority)}</span>` : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.title)}</title>
<style>
  :root { --fg: #111827; --muted: #6b7280; --line: #e5e7eb; --bg: #fff; --soft: #f9fafb; --bad: #fef2f2; --badfg: #991b1b; --warn: #fffbeb; --accent: #4f46e5; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e5e7eb; --muted: #9ca3af; --line: #374151; --bg: #111827; --soft: #1f2937; --bad: #3b1d1d; --badfg: #fca5a5; --warn: #3a2f12; --accent: #818cf8; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  h2 { font-size: 16px; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--line); }
  .meta { color: var(--muted); font-size: 13px; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; border: 1px solid var(--line); margin-right: 4px; }
  .sev-critical, .sev-major { background: var(--bad); color: var(--badfg); border-color: transparent; }
  .tech { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); border-color: transparent; }
  ol.steps li { margin: 4px 0; }
  .detail { color: var(--muted); font-size: 12px; }
  .tag { font-size: 11px; padding: 0 6px; border-radius: 999px; background: var(--soft); border: 1px solid var(--line); }
  .warnbox { background: var(--warn) !important; }
  .box { background: var(--soft); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; white-space: pre-wrap; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  tr.bad td { background: var(--bad); }
  tr.warn td { background: var(--warn); }
  code, pre { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
  pre { white-space: pre-wrap; word-break: break-all; margin: 4px 0; max-height: 240px; overflow: auto; background: var(--soft); padding: 6px; border-radius: 6px; }
  .shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
  figure { margin: 0; } figure img { width: 100%; border: 1px solid var(--line); border-radius: 6px; }
  img.zoom { cursor: zoom-in; }
  #lightbox { position: fixed; inset: 0; z-index: 10; overflow: auto; background: rgba(0, 0, 0, .94); cursor: zoom-out; padding: 16px; box-sizing: border-box; }
  #lightbox[hidden] { display: none; }
  #lightbox img { display: block; max-width: none; margin: 0 auto; background: #fff; }
  #lightbox p { color: #fff; margin: 0 0 8px; font-size: 12px; text-align: center; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 12px 0; }
  .toolbar button { font: inherit; padding: 5px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--soft); color: var(--fg); cursor: pointer; }
  .toolbar button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  textarea#jira-wiki { width: 100%; box-sizing: border-box; min-height: 200px; font: 12px ui-monospace, Menlo, Consolas, monospace; background: var(--soft); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 6px; }
  @media print { .toolbar, .jira { display: none; } }
  figcaption { color: var(--muted); font-size: 12px; }
  .wrap { overflow-x: auto; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0; }
  dt { color: var(--muted); } dd { margin: 0; word-break: break-word; }
</style></head>
<body><main>
  <h1>${esc(r.title)}</h1>
  <div>${sev}${pri}${r.techniques.map((t) => `<span class="pill tech">${esc(t.name)}</span>`).join('')}</div>
  <div class="toolbar">
    <button type="button" class="primary" id="copy-jira">Copy description for Jira</button>
    <button type="button" id="copy-summary">Copy summary</button>
    <span class="meta" id="copy-status" role="status"></span>
  </div>
  ${jira.attachments.length ? `<p class="meta">Attach the screenshots from the <code>attachments</code> folder next to this report: ${jira.attachments.map((a) => `<code>${esc(a.name)}</code>`).join(', ')}.</p>` : ''}
  ${mockWarning(r) ? `<p class="box warnbox">⚠️ ${esc(mockWarning(r))}</p>` : ''}
  <p class="meta">Reported ${esc(new Date(r.createdAt).toLocaleString())}${r.reporter ? ` by ${esc(r.reporter)}` : ''}</p>

  <h2>Environment</h2>
  <dl>
    <dt>URL</dt><dd>${esc(r.environment.url ?? 'n/a')}</dd>
    <dt>Browser</dt><dd>${esc(r.environment.browser)}</dd>
    ${r.environment.userAgent ? `<dt>User agent</dt><dd><code>${esc(r.environment.userAgent)}</code></dd>` : ''}
    ${r.environment.device ? `<dt>Device emulation</dt><dd>${esc(r.environment.device)}</dd>` : ''}
    ${r.environment.viewport ? `<dt>Viewport</dt><dd>${esc(viewportText(r.environment.viewport))}</dd>` : ''}
  </dl>

  <h2>Steps to reproduce</h2>
  <ol class="steps">${r.steps.map((s) => `<li>${esc(s.text)}${s.expected ? ` <span class="tag">expected ${esc(s.expected)}</span>` : ''}${s.detail ? `<div class="detail">${esc(s.detail)}</div>` : ''}</li>`).join('')}</ol>

  <h2>Expected result</h2>
  <div class="box">${esc(r.expected ?? 'Not stated.')}</div>
  <h2>Actual result</h2>
  <div class="box">${esc(r.actual)}</div>

  <h2>Test design technique (ISTQB)</h2>
  <ul>${r.techniques.map((t) => `<li><b>${esc(t.name)}</b>${t.reason ? `: ${esc(t.reason)}` : ''}${t.detected ? '' : ' <span class="tag">set by tester</span>'}</li>`).join('')}</ul>

  ${r.failedApiCalls.length ? `<h2>Failed API calls</h2><div class="wrap">${calls(r.failedApiCalls)}</div>` : ''}
  ${r.slowApiCalls.length ? `<h2>Slow API calls (over ${r.slowThresholdMs} ms)</h2><div class="wrap">${calls(r.slowApiCalls)}</div>` : ''}
  ${r.pageErrors.length || r.consoleErrors.length ? `<h2>Console and JavaScript errors</h2><div class="wrap"><table><thead><tr><th>Step</th><th>Type</th><th>Message</th></tr></thead><tbody>
    ${r.pageErrors.map((e) => `<tr class="bad"><td>${e.step ?? ''}</td><td>Uncaught error</td><td>${esc(e.message)}${e.stack ? `<details><summary>Stack</summary><pre>${esc(e.stack)}</pre></details>` : ''}</td></tr>`).join('')}
    ${r.consoleErrors.map((e) => `<tr class="${e.level === 'error' ? 'bad' : 'warn'}"><td>${e.step ?? ''}</td><td>Console ${esc(e.level)}</td><td>${esc(e.text)}${e.location ? `<div class="detail">${esc(e.location)}</div>` : ''}</td></tr>`).join('')}
  </tbody></table></div>` : ''}

  ${r.apiPerformance.length ? `<h2>API response times</h2><div class="wrap"><table><thead><tr><th>Endpoint</th><th>Calls</th><th>Errors</th><th>Avg</th><th>p95</th><th>Max</th></tr></thead><tbody>
    ${r.apiPerformance.map((p) => `<tr class="${p.errors ? 'bad' : p.maxMs >= r.slowThresholdMs ? 'warn' : ''}"><td><code>${esc(p.endpoint)}</code></td><td>${p.calls}</td><td>${p.errors}</td><td>${p.avgMs} ms</td><td>${p.p95Ms} ms</td><td>${p.maxMs} ms</td></tr>`).join('')}
  </tbody></table></div>` : ''}

  ${r.accessibility.map((scan) => htmlA11y(scan, sessionDir)).join('')}
  ${r.layout.map((check) => htmlLayout(check, sessionDir)).join('')}

  ${r.mocks.length ? `<h2>API mocks used</h2><ul>${r.mocks.map((m) => `<li><b>${esc(m.rule)}</b> (${m.calls} call${m.calls > 1 ? 's' : ''}): ${esc(m.changes.slice(0, 8).join('; ') || 'no changes')}</li>`).join('')}</ul>` : ''}

  ${r.notes ? `<h2>Notes</h2><div class="box">${esc(r.notes)}</div>` : ''}

  ${r.screenshot || shots.length ? `<h2>Screenshots</h2><div class="shots">
    ${r.screenshot ? `<figure>${image(sessionDir, r.screenshot, 'When the bug was reported')}<figcaption>When the bug was reported</figcaption></figure>` : ''}
    ${shots.map((s) => `<figure>${image(sessionDir, s.screenshot, `After step ${s.number}`)}<figcaption>After step ${s.number}: ${esc(s.text)}</figcaption></figure>`).join('')}
  </div>` : ''}

  <details class="jira"><summary>Jira text (wiki markup)</summary>
    <p class="meta">The copy button puts this on the clipboard together with a rich-text version. Jira Cloud pastes the rich text; Jira Server and Data Center text mode use this markup.</p>
    <textarea id="jira-wiki" readonly aria-label="Jira description in wiki markup">${esc(jira.wiki)}</textarea>
  </details>
  <template id="jira-html">${jira.html}</template>
  <p class="meta">Network log: network.har in the session folder · Generated by qa-recorder</p>
</main>
<div id="lightbox" hidden tabindex="-1" role="dialog" aria-label="Screenshot at full size"><p>Full size. Click or press Esc to close.</p><img alt=""></div>
<script>${REPORT_SCRIPT}</script>
</body></html>`;
}

// ---------- writing ----------

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'bug';
}

export interface WrittenReport {
  dir: string;
  html: string;
  markdown: string;
  json: string;
  /** Jira wiki markup of the description (jira.txt). */
  jiraFile: string;
  /** Folder with the screenshots to attach to the Jira ticket. */
  attachmentsDir: string;
  jira: JiraCopy;
  report: BugReport;
}

/**
 * Writes report.html, report.md, jira.txt and bug.json into `<sessionDir>/bugs/<nn>-<title>/`,
 * with the report's screenshots copied into `attachments/` for the Jira ticket.
 */
export function writeBugReport(sessionDir: string, session: SessionData, input: BugInput = {}): WrittenReport {
  const report = buildBugReport(session, input);
  const bugsDir = join(sessionDir, 'bugs');
  mkdirSync(bugsDir, { recursive: true });
  const used = readdirSync(bugsDir).map((name) => Number(name.split('-')[0])).filter(Number.isFinite);
  const n = used.length ? Math.max(...used) + 1 : 1;
  const dir = join(bugsDir, `${String(n).padStart(2, '0')}-${slug(report.title)}`);
  mkdirSync(dir, { recursive: true });
  const html = join(dir, 'report.html');
  const markdown = join(dir, 'report.md');
  const json = join(dir, 'bug.json');
  const jiraFile = join(dir, 'jira.txt');
  const attachmentsDir = join(dir, 'attachments');
  const jira = jiraCopy(report);
  for (const a of jira.attachments) {
    const from = join(sessionDir, a.source);
    if (!existsSync(from)) continue;
    mkdirSync(attachmentsDir, { recursive: true });
    copyFileSync(from, join(attachmentsDir, a.name));
  }
  writeFileSync(jiraFile, jira.wiki);
  writeFileSync(html, renderHtml(report, sessionDir, jira));
  writeFileSync(markdown, renderMarkdown(report, relative(dir, sessionDir).replace(/\\/g, '/') || '.'));
  writeFileSync(json, JSON.stringify(report, null, 2));
  return { dir, html, markdown, json, jiraFile, attachmentsDir, jira, report };
}
