// qa-recorder test data panel. Injected into the top frame of every tab.
// Plain JavaScript, rendered inside a closed shadow root so the app's CSS
// can't reach it and Playwright locators can't match it. Generation and
// filling happen in Node through the __qaPanel binding.
(() => {
  if (window !== window.top || window.__qaPanelUi) return;

  const TAG = 'qa-recorder-panel';
  const state = {
    open: false,
    tab: 'faker',
    init: null,
    target: null,
    spec: { type: 'email', locale: 'en_US', options: {} },
    preview: [],
    cases: [],
    range: { kind: 'length', min: '', max: '', step: '', mode: '2-value', partitions: true, charset: 'text' },
    bypassMaxLength: false,
    profileName: '',
    capture: { state: 'idle' },
    loop: { iterations: 5, delayMs: 500, reload: false, values: {} },
    loopStatus: null,
    bug: null,
    bugForm: {
      scope: 'session', severity: 'major', priority: 'medium', title: '', expected: '', actual: '', notes: '', techniques: [],
      excludeSteps: [], excludeScreenshots: [], pageScreenshot: true,
    },
    bugPreview: {},
    lastBug: null,
    mocks: { rules: [], active: 0, recent: [] },
    mockEdit: null,
    a11y: { options: { version: '2.2', level: 'AA', bestPractices: false }, scan: null, expanded: {} },
    rwd: {
      init: null, presets: null, landscape: false, widths: '', current: true, fullPage: false,
      boundaries: null, picked: {}, check: null, expanded: {}, resizeTo: 'iPhone SE (3rd gen)', resized: null,
    },
    message: null,
    busy: false,
  };

  // ---------- helpers ----------

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'value') el.value = value;
      else if (key === 'checked') el.checked = Boolean(value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : String(child));
    }
    return el;
  }

  async function call(cmd, args) {
    if (typeof window.__qaPanel !== 'function') throw new Error('Recorder is not connected');
    const response = await window.__qaPanel(Object.assign({ cmd }, args || {}));
    if (!response.ok) throw new Error(response.error);
    return response.result;
  }

  function flash(text, kind) {
    state.message = { text, kind: kind || 'info' };
    render();
  }

  async function run(fn) {
    state.busy = true;
    state.message = null;
    render();
    try {
      await fn();
    } catch (error) {
      state.message = { text: error.message, kind: 'error' };
    } finally {
      state.busy = false;
      render();
    }
  }

  function preview(value, max) {
    const limit = max || 40;
    const shown = value.replace(/\n/g, '⏎');
    return shown.length > limit ? `${shown.slice(0, limit)}… (${value.length})` : shown || '(empty)';
  }

  function catalogEntry(id) {
    return state.init && state.init.catalog.find((c) => c.id === id);
  }

  function techniqueName(id) {
    const t = state.init && state.init.techniques.find((x) => x.id === id);
    return t ? t.name : id;
  }

  // ---------- styles ----------

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
    .pill.warn { background: #b45309; }
    textarea.ta { width: 100%; font: 12px ui-monospace, Menlo, monospace; padding: 5px 6px; border: 1px solid #d1d5db; border-radius: 6px; color: #111827; background: #fff; }
    .pill { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; background: #1f2937; color: #fff;
      border: 0; border-radius: 999px; padding: 8px 14px; font-size: 13px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
    .panel { position: fixed; right: 16px; bottom: 60px; z-index: 2147483647; width: 400px; max-width: calc(100vw - 32px);
      max-height: calc(100vh - 80px); display: flex; flex-direction: column; background: #fff; color: #111827;
      border: 1px solid #d1d5db; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.25); font-size: 13px; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid #e5e7eb; }
    header b { font-size: 14px; }
    .target { padding: 8px 12px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; font-size: 12px; color: #374151; }
    .target code { background: #eef2ff; padding: 1px 4px; border-radius: 4px; }
    .tabs { display: flex; flex-wrap: wrap; border-bottom: 1px solid #e5e7eb; }
    .tabs button { flex: 1 0 auto; border: 0; background: none; padding: 7px 6px; cursor: pointer; font-size: 12px; color: #6b7280; border-bottom: 2px solid transparent; }
    .tabs button.on { color: #111827; border-bottom-color: #4f46e5; font-weight: 600; }
    .body { padding: 10px 12px; overflow: auto; flex: 1; }
    label.f { display: block; margin: 6px 0 2px; font-size: 12px; color: #374151; }
    input, select { width: 100%; padding: 5px 6px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; background: #fff; color: #111827; }
    input[type=checkbox], input[type=radio] { width: auto; }
    .row { display: flex; gap: 6px; align-items: center; }
    .row > * { flex: 1; }
    .row > .auto { flex: 0 0 auto; }
    button.b { border: 1px solid #d1d5db; background: #fff; border-radius: 6px; padding: 5px 10px; cursor: pointer; font-size: 12px; color: #111827; }
    button.p { background: #4f46e5; border-color: #4f46e5; color: #fff; }
    button.d { color: #b91c1c; }
    button:disabled { opacity: .5; cursor: default; }
    .actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
    ul { list-style: none; margin: 8px 0 0; padding: 0; }
    li { display: flex; gap: 6px; align-items: center; padding: 5px 0; border-top: 1px solid #f3f4f6; }
    li .grow { flex: 1; min-width: 0; }
    li .v { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #4b5563; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; white-space: nowrap; }
    .valid { background: #dcfce7; color: #166534; }
    .invalid { background: #fee2e2; color: #991b1b; }
    .tech { background: #eef2ff; color: #3730a3; }
    .imp-critical, .imp-serious, .sev-error { background: #fee2e2; color: #991b1b; }
    .imp-moderate, .sev-warning { background: #fef3c7; color: #92400e; }
    .imp-minor { background: #dbeafe; color: #1e40af; }
    .ok-badge { background: #dcfce7; color: #166534; }
    .issue { font-size: 12px; color: #374151; padding: 3px 0; }
    .grp { font-size: 11px; color: #6b7280; margin: 6px 0 2px; }
    .checks label { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; margin: 2px 10px 2px 0; }
    .msg { margin: 8px 12px; padding: 6px 8px; border-radius: 6px; font-size: 12px; }
    .msg.info { background: #eff6ff; color: #1e40af; }
    .msg.error { background: #fef2f2; color: #991b1b; }
    .msg.ok { background: #f0fdf4; color: #166534; }
    .muted { color: #6b7280; font-size: 12px; }
    .pick { max-height: 200px; overflow: auto; border: 1px solid #e5e7eb; border-radius: 6px; padding: 2px 6px; }
    .pick label { display: flex; gap: 6px; align-items: flex-start; font-size: 12px; padding: 3px 0; }
    .pick label.off { color: #9ca3af; text-decoration: line-through; }
    .pick .shot { display: flex; gap: 6px; align-items: flex-start; border-top: 1px solid #f3f4f6; }
    .pick .shot label { flex: 1; min-width: 0; }
    .pick img { display: block; max-width: 100%; margin: 2px 0 6px; border: 1px solid #e5e7eb; border-radius: 4px; }
    button.link { border: 0; background: none; color: #4f46e5; cursor: pointer; font-size: 12px; padding: 3px 0; white-space: nowrap; }
    h4 { margin: 10px 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; }
  `;

  // ---------- mount ----------

  let root;
  function mount() {
    if (root || !document.documentElement) return;
    const host = document.createElement(TAG);
    const attach = window.__qaRecorder && window.__qaRecorder.attachShadow;
    root = attach ? attach(host, { mode: 'closed' }) : host.attachShadow({ mode: 'closed' });
    document.documentElement.append(host);
    render();
    // Show active mocks on the button even before the panel is opened.
    call('mockState').then((m) => { state.mocks = m; render(); }).catch(() => undefined);
  }

  async function ensureInit() {
    if (state.init) return;
    state.init = await call('init');
    state.target = state.init.target;
    state.capture = state.init.capture;
    state.mocks = await call('mockState');
    await ensureRwd();
  }

  // ---------- mocks ----------

  const METHODS = ['', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  const FAILURES = ['failed', 'timedout', 'connectionrefused', 'internetdisconnected', 'aborted'];

  function emptyRule() {
    return {
      name: '', method: '', url: '', enabled: true, once: false, delayMs: '',
      request: { headers: '', fields: '', body: '' },
      response: { mode: '', status: '', headers: '', fields: '', body: '', failure: 'failed' },
    };
  }

  function editRule(rule) {
    const base = emptyRule();
    state.mockEdit = {
      ...base,
      ...rule,
      method: rule.method || '',
      delayMs: rule.delayMs || '',
      request: { ...base.request, ...(rule.request || {}) },
      response: { ...base.response, ...(rule.response || {}), status: rule.response && rule.response.status !== undefined ? rule.response.status : '' },
    };
    render();
  }

  function ruleSummary(r) {
    const parts = [];
    if (r.request) parts.push('edits request');
    if (r.response) {
      if (r.response.mode === 'fail') parts.push(`network ${r.response.failure || 'failed'}`);
      else if (r.response.mode === 'replace') parts.push(`returns ${r.response.status || 200} (no server call)`);
      else parts.push(r.response.status ? `status → ${r.response.status}` : 'edits response');
    }
    if (r.delayMs) parts.push(`+${r.delayMs} ms`);
    if (r.once) parts.push('once');
    return parts.join(', ');
  }

  function pathOf(url) {
    try {
      const u = new URL(url);
      return u.pathname + u.search;
    } catch (_) {
      return url;
    }
  }

  function mockEditor() {
    const r = state.mockEdit;
    const field = (obj, key, label, placeholder, rows) => h('div', null,
      h('label', { class: 'f' }, label),
      rows
        ? h('textarea', { 'aria-label': label, rows, placeholder: placeholder || '', class: 'ta', oninput: (e) => { obj[key] = e.target.value; } }, obj[key] || '')
        : h('input', { 'aria-label': label, placeholder: placeholder || '', value: obj[key] ?? '', oninput: (e) => { obj[key] = e.target.value; } }));
    const mode = r.response.mode;
    return h('div', null,
      h('h4', null, r.id ? 'Edit mock' : 'New mock'),
      field(r, 'name', 'Name', 'e.g. Orders API fails'),
      h('div', { class: 'row' },
        h('div', { class: 'auto', style: 'width:90px' }, h('label', { class: 'f' }, 'Method'),
          h('select', { 'aria-label': 'Method', onchange: (e) => { r.method = e.target.value; } },
            METHODS.map((m) => h('option', { value: m, selected: (r.method || '') === m }, m || 'Any')))),
        field(r, 'url', 'URL contains', '/api/orders, */orders/*, or /regex/')),

      h('h4', null, 'Before it is sent (request)'),
      field(r.request, 'headers', 'Headers to set or remove', 'Authorization: Bearer expired-token\n-X-Request-Id', 2),
      field(r.request, 'fields', 'JSON fields to change', 'quantity = 0\nuser.role = "admin"\n-coupon', 2),
      field(r.request, 'body', 'Replace the whole body (optional)', '', 2),

      h('h4', null, 'After it is sent (response)'),
      h('select', { 'aria-label': 'Response mode', onchange: (e) => { r.response.mode = e.target.value; render(); } },
        [['', "Don't change the response"], ['modify', 'Change the real response'], ['replace', "Return my response (don't call the server)"], ['fail', 'Simulate a network failure']]
          .map(([v, label]) => h('option', { value: v, selected: mode === v }, label))),
      mode === 'fail'
        ? h('div', null, h('label', { class: 'f' }, 'Failure'),
          h('select', { 'aria-label': 'Failure', onchange: (e) => { r.response.failure = e.target.value; } },
            FAILURES.map((f) => h('option', { value: f, selected: r.response.failure === f }, f))))
        : null,
      mode === 'modify' || mode === 'replace' ? h('div', null,
        h('div', { class: 'row' },
          h('div', { class: 'auto', style: 'width:110px' }, field(r.response, 'status', 'Status code', mode === 'replace' ? '200' : 'keep')),
          h('div', { class: 'muted' }, 'e.g. 200, 401, 404, 500, 503')),
        field(r.response, 'headers', 'Headers to set or remove', 'Content-Type: application/json\n-Cache-Control', 2),
        field(r.response, 'fields', 'JSON fields to change', 'data.items = []\ndata.total = 0\n-data.user.email', 2),
        field(r.response, 'body', mode === 'replace' ? 'Response body' : 'Replace the whole body (optional)', '{"error": "Service unavailable"}', 4)) : null,

      h('div', { class: 'row', style: 'margin-top:6px' },
        h('div', { class: 'auto', style: 'width:110px' }, field(r, 'delayMs', 'Delay (ms)', '0')),
        h('label', { class: 'f auto' }, h('input', { type: 'checkbox', checked: r.once, onchange: (e) => { r.once = e.target.checked; } }), ' Only once'),
        h('label', { class: 'f auto' }, h('input', { type: 'checkbox', checked: r.enabled, onchange: (e) => { r.enabled = e.target.checked; } }), ' On')),
      h('div', { class: 'actions' },
        h('button', {
          class: 'b p', disabled: state.busy,
          onclick: () => run(async () => {
            const rule = {
              ...r,
              delayMs: r.delayMs === '' ? undefined : Number(r.delayMs),
              response: r.response.mode ? { ...r.response, status: r.response.status === '' ? undefined : Number(r.response.status), failure: r.response.mode === 'fail' ? r.response.failure : undefined } : undefined,
            };
            state.mocks = await call('mockSave', { rule });
            state.mockEdit = null;
            flash('Mock saved', 'ok');
          }),
        }, 'Save mock'),
        h('button', { class: 'b', onclick: () => { state.mockEdit = null; render(); } }, 'Cancel')));
  }

  function mockView() {
    if (state.mockEdit) return mockEditor();
    const m = state.mocks;
    return h('div', null,
      m.active ? h('div', { class: 'msg info', style: 'margin:0 0 6px' }, `${m.active} mock${m.active > 1 ? 's are' : ' is'} on. Matching API calls are being changed.`) : null,
      h('div', { class: 'actions', style: 'margin-top:0' },
        h('button', { class: 'b p', onclick: () => editRule(emptyRule()) }, 'New mock')),
      m.rules.length ? h('ul', null, m.rules.map((r) => h('li', null,
        h('input', {
          type: 'checkbox', checked: r.enabled, title: r.enabled ? 'Turn off' : 'Turn on', 'aria-label': `Mock ${r.name} on`,
          onchange: (e) => run(async () => { state.mocks = await call('mockToggle', { id: r.id, enabled: e.target.checked }); }),
        }),
        h('div', { class: 'grow' },
          h('div', null, h('b', null, r.name), r.hits ? h('span', { class: 'muted' }, ` · used ${r.hits}×`) : null),
          h('div', { class: 'v' }, `${r.method || 'ANY'} ${r.url} · ${ruleSummary(r)}`)),
        h('button', { class: 'b', onclick: () => editRule(r) }, 'Edit'),
        h('button', { class: 'b d', title: 'Delete', onclick: () => run(async () => { state.mocks = await call('mockDelete', { id: r.id }); }) }, '×')))) : h('div', { class: 'muted', style: 'margin-top:6px' }, 'No mocks yet. Pick a recent API call below, or start a new one.'),
      h('h4', null, 'Recent API calls'),
      m.recent.length ? h('ul', null, m.recent.slice(0, 15).map((c) => h('li', null,
        h('div', { class: 'grow' },
          h('div', { class: 'v', title: c.url }, `${c.method} ${pathOf(c.url)}`),
          h('div', { class: 'muted' }, `${c.status ?? 'failed'}${c.mocked ? ` · mocked by ${c.mocked}` : ''}`)),
        h('button', { class: 'b', onclick: () => run(async () => editRule(await call('mockFromCall', { seq: c.seq }))) }, 'Mock this')))) : h('div', { class: 'muted' }, 'API calls will appear here as the page makes them.'));
  }

  // ---------- accessibility ----------

  function a11yView() {
    const a = state.a11y;
    const o = a.options;
    const scan = a.scan;
    return h('div', null,
      h('div', { class: 'muted' }, 'Checks the page as it is now with axe-core. Open menus, dialogs and error states first to check them too.'),
      h('div', { class: 'row', style: 'margin-top:6px' },
        h('div', null, h('label', { class: 'f' }, 'WCAG version'),
          h('select', { 'aria-label': 'WCAG version', onchange: (e) => { o.version = e.target.value; } },
            ['2.0', '2.1', '2.2'].map((v) => h('option', { value: v, selected: o.version === v }, `WCAG ${v}`)))),
        h('div', null, h('label', { class: 'f' }, 'Level'),
          h('select', { 'aria-label': 'WCAG level', onchange: (e) => { o.level = e.target.value; } },
            ['A', 'AA', 'AAA'].map((v) => h('option', { value: v, selected: o.level === v }, v))))),
      h('label', { class: 'f' },
        h('input', { type: 'checkbox', checked: o.bestPractices, onchange: (e) => { o.bestPractices = e.target.checked; } }),
        ' Include best practices (not WCAG failures)'),
      h('div', { class: 'actions' },
        h('button', {
          class: 'b p', disabled: state.busy,
          onclick: () => run(async () => {
            a.scan = await call('a11yScan', { options: { ...o } });
            a.expanded = {};
          }),
        }, scan ? 'Scan again' : 'Scan this page')),
      scan ? a11yResults(scan) : null);
  }

  function a11yResults(scan) {
    const r = scan.result;
    const a = state.a11y;
    return h('div', null,
      h('div', { class: `msg ${r.violations.length ? 'error' : 'ok'}`, style: 'margin:8px 0 0' }, scan.summary),
      h('div', { class: 'muted', style: 'margin-top:4px' },
        `${r.passes} rules passed, ${r.needsReview.length} need a manual check. Added to the next bug report.`),
      r.violations.length ? h('ul', null, r.violations.map((v, i) => h('li', { style: 'display:block' },
        h('div', { class: 'row' },
          h('div', { class: 'grow' },
            h('div', null, h('b', null, `${i + 1}. `), v.help, ' ',
              h('span', { class: `badge imp-${v.impact || 'minor'}` }, v.impact || 'minor')),
            h('div', { class: 'muted' }, `${v.wcag.length ? `WCAG ${v.wcag.join(', ')} (${v.level})` : 'Best practice'} · ${v.nodeCount} element${v.nodeCount > 1 ? 's' : ''} · ${v.id}`)),
          h('button', { class: 'b auto', onclick: () => { a.expanded[v.id] = !a.expanded[v.id]; render(); } }, a.expanded[v.id] ? 'Hide' : 'Elements')),
        a.expanded[v.id] ? h('ul', null, v.nodes.map((n) => h('li', null,
          h('div', { class: 'grow' },
            h('div', { class: 'v', title: n.html }, n.selector),
            n.summary ? h('div', { class: 'muted' }, n.summary.split('\n').map((l) => l.trim()).filter((l) => l && !/^Fix (any|all) of the following/i.test(l)).slice(0, 2).join('; ')) : null),
          h('button', {
            class: 'b auto', title: 'Scroll to it and outline it',
            onclick: () => run(async () => {
              const found = await call('a11yShow', { target: n.target, label: String(i + 1) });
              if (!found) flash('That element is not on the page any more', 'info');
            }),
          }, 'Show')))) : null))) : null,
      r.needsReview.length ? h('div', null,
        h('h4', null, 'Needs a manual check'),
        h('ul', null, r.needsReview.map((v) => h('li', null,
          h('span', { class: 'grow' }, v.help, ' ', h('span', { class: 'muted' }, `(${v.nodeCount})`)))))) : null,
      scan.screenshot ? h('div', { class: 'muted', style: 'margin-top:6px' }, `Screenshot with issues outlined: ${scan.screenshot}`) : null);
  }

  // ---------- responsive ----------

  async function ensureRwd() {
    const r = state.rwd;
    if (r.init) return;
    r.init = await call('auditInit');
    if (!r.presets) r.presets = Object.fromEntries(r.init.presets.map((p) => [p.id, r.init.defaults.includes(p.id)]));
    if (r.init.resized) r.resized = { label: 'custom size' };
  }

  function rwdView() {
    const r = state.rwd;
    if (!r.init) return h('div', { class: 'muted' }, 'Loading…');
    const groups = {};
    for (const p of r.init.presets) (groups[p.group] = groups[p.group] || []).push(p);
    const picked = (b) => r.picked[b.width] !== false;
    return h('div', null,
      h('h4', { style: 'margin-top:0' }, 'Resize this tab'),
      h('div', { class: 'row' },
        h('select', { 'aria-label': 'Resize to', onchange: (e) => { r.resizeTo = e.target.value; } },
          r.init.presets.map((p) => h('option', { value: p.id, selected: r.resizeTo === p.id }, `${p.name} (${p.width}×${p.height})`))),
        h('button', {
          class: 'b auto', disabled: state.busy,
          onclick: () => run(async () => {
            const res = await call('resize', { preset: r.resizeTo });
            r.resized = res;
            flash(`Tab is now ${res.width}×${res.height}. Keep testing; it is recorded as a step.`, 'ok');
          }),
        }, 'Resize'),
        r.resized ? h('button', {
          class: 'b auto', disabled: state.busy,
          onclick: () => run(async () => { await call('resize', { reset: true }); r.resized = null; flash('Back to the original size', 'ok'); }),
        }, 'Restore') : null),
      h('div', { class: 'muted', style: 'margin-top:4px' }, 'Changes the page size only. For a real phone (touch, user agent, pixel ratio) record with --device.'),

      h('h4', null, 'Check the layout at these sizes'),
      h('div', { class: 'checks' }, Object.entries(groups).map(([group, list]) => h('div', null,
        h('div', { class: 'grp' }, group),
        list.map((p) => h('label', null,
          h('input', { type: 'checkbox', checked: r.presets[p.id], onchange: (e) => { r.presets[p.id] = e.target.checked; } }),
          `${p.name} ${p.width}`))))),
      h('div', { class: 'row', style: 'margin-top:4px' },
        h('div', null, h('label', { class: 'f' }, 'Extra widths (px)'),
          h('input', { 'aria-label': 'Extra widths', placeholder: 'e.g. 360, 1024', value: r.widths, oninput: (e) => { r.widths = e.target.value; } }))),
      h('div', { class: 'checks', style: 'margin-top:4px' },
        h('label', null, h('input', { type: 'checkbox', checked: r.landscape, onchange: (e) => { r.landscape = e.target.checked; } }), 'Landscape'),
        h('label', null, h('input', { type: 'checkbox', checked: r.current, onchange: (e) => { r.current = e.target.checked; } }), 'This tab as it is now'),
        h('label', null, h('input', { type: 'checkbox', checked: r.fullPage, onchange: (e) => { r.fullPage = e.target.checked; } }), 'Full-page screenshots')),

      h('h4', null, 'CSS breakpoints (boundary value analysis)'),
      r.boundaries === null
        ? h('div', null,
          h('div', { class: 'muted' }, "Reads the page's @media rules and checks just before and just after each width where the layout switches."),
          h('div', { class: 'actions' }, h('button', {
            class: 'b', disabled: state.busy,
            onclick: () => run(async () => {
              const found = await call('breakpoints');
              r.boundaries = found.boundaries;
              r.picked = {};
              if (found.unreadable.length) flash(`Could not read ${found.unreadable.length} stylesheet(s)`, 'info');
            }),
          }, 'Find breakpoints')))
        : r.boundaries.length
          ? h('div', { class: 'checks' }, r.boundaries.map((b) => h('label', { title: b.reason },
            h('input', { type: 'checkbox', checked: picked(b), onchange: (e) => { r.picked[b.width] = e.target.checked; } }), `${b.width}`)),
          h('div', { class: 'muted' }, `${r.boundaries.length / 2} breakpoint${r.boundaries.length > 2 ? 's' : ''} found. Hover a width to see the rule.`))
          : h('div', { class: 'muted' }, 'No width breakpoints found in the CSS.'),

      h('div', { class: 'actions' },
        h('button', {
          class: 'b p', disabled: state.busy,
          onclick: () => run(async () => {
            const request = {
              presets: Object.entries(r.presets).filter(([, on]) => on).map(([id]) => id),
              landscape: r.landscape,
              widths: r.widths.split(/[\s,]+/).filter(Boolean).map(Number),
              boundaries: (r.boundaries || []).filter(picked),
              current: r.current,
              fullPage: r.fullPage,
            };
            flash('Checking… pages load fresh at each size in a hidden browser.', 'info');
            r.check = await call('layoutCheck', { request });
            r.expanded = {};
            state.message = null;
          }),
        }, r.check ? 'Check again' : 'Run layout check')),
      r.check ? rwdResults(r.check) : null);
  }

  function rwdResults(check) {
    const r = state.rwd;
    const bad = check.result.viewports.some((v) => v.error || v.issues.some((i) => i.severity === 'error'));
    return h('div', null,
      h('div', { class: `msg ${bad ? 'error' : check.result.viewports.some((v) => v.issues.length) ? 'info' : 'ok'}`, style: 'margin:8px 0 0' }, check.summary),
      h('ul', null, check.result.viewports.map((v, i) => {
        const errors = v.issues.filter((x) => x.severity === 'error').length;
        const warnings = v.issues.length - errors;
        return h('li', { style: 'display:block' },
          h('div', { class: 'row' },
            h('div', { class: 'grow' },
              h('div', null, h('b', null, v.label), ' ', h('span', { class: 'muted' }, v.fresh ? `${v.width}×${v.height}` : '')),
              h('div', null,
                v.error ? h('span', { class: 'badge sev-error' }, 'not checked') : null,
                errors ? h('span', { class: 'badge sev-error' }, `${errors} error${errors > 1 ? 's' : ''}`) : null, ' ',
                warnings ? h('span', { class: 'badge sev-warning' }, `${warnings} warning${warnings > 1 ? 's' : ''}`) : null,
                !v.error && !v.issues.length ? h('span', { class: 'badge ok-badge' }, 'no issues') : null)),
            v.issues.length || v.error ? h('button', { class: 'b auto', onclick: () => { r.expanded[i] = !r.expanded[i]; render(); } }, r.expanded[i] ? 'Hide' : 'Details') : null),
          r.expanded[i] ? h('div', null,
            v.error ? h('div', { class: 'issue' }, v.error) : null,
            v.issues.map((x) => h('div', { class: 'issue' }, x.marker ? h('b', null, `[${x.marker}] `) : null, x.message)),
            v.screenshot ? h('div', { class: 'muted' }, v.screenshot) : null) : null);
      })),
      h('div', { class: 'muted', style: 'margin-top:6px' }, 'Screenshots have numbered boxes on the problem elements. Added to the next bug report.'));
  }

  function toggle() {
    state.open = !state.open;
    if (state.open) run(ensureInit);
    else render();
  }

  // ---------- views ----------

  function targetView() {
    const t = state.target;
    if (!t) return h('div', { class: 'target' }, 'Click into a field on the page to choose where values go.');
    const c = t.constraints || {};
    const facts = [c.type];
    if (c.maxLength !== undefined) facts.push(`maxlength ${c.maxLength}`);
    if (c.minLength !== undefined) facts.push(`minlength ${c.minLength}`);
    if (c.min !== undefined || c.max !== undefined) facts.push(`range ${c.min ?? '…'} to ${c.max ?? '…'}`);
    if (c.pattern) facts.push(`pattern ${c.pattern}`);
    if (c.required) facts.push('required');
    if (t.inFrame) facts.push('in iframe');
    if (t.inShadowDom) facts.push('in shadow DOM');
    return h('div', { class: 'target' }, 'Field: ', h('b', null, t.label), ' ', h('span', { class: 'muted' }, `(${facts.join(', ')})`));
  }

  function fakerView() {
    const init = state.init;
    const entry = catalogEntry(state.spec.type) || { options: [] };
    const groups = {};
    for (const c of init.catalog) (groups[c.group] = groups[c.group] || []).push(c);

    const typeSelect = h('select', {
      'aria-label': 'Data type',
      onchange: (e) => { state.spec = { ...state.spec, type: e.target.value, options: {} }; state.preview = []; render(); },
    }, Object.entries(groups).map(([group, items]) =>
      h('optgroup', { label: group }, items.map((c) => h('option', { value: c.id, selected: c.id === state.spec.type }, c.label)))));

    const localeSelect = h('select', {
      'aria-label': 'Locale',
      onchange: (e) => { state.spec = { ...state.spec, locale: e.target.value }; },
    }, init.locales.map((l) => h('option', { value: l, selected: l === state.spec.locale }, l)));

    const optionLabels = {
      min: 'Min', max: 'Max', length: 'Length', precision: 'Decimal places',
      pattern: 'Pattern (regex), e.g. [A-Z]{3}-[0-9]{4}',
      template: 'Template, e.g. {{person.firstName}}.qa+{i}@test.com',
      path: 'Faker method, e.g. vehicle.vin', args: 'Arguments as JSON (optional)',
    };
    const numeric = new Set(['min', 'max', 'length', 'precision']);
    const optionInputs = entry.options.map((name) => h('div', null,
      h('label', { class: 'f' }, optionLabels[name]),
      h('input', {
        'aria-label': optionLabels[name],
        type: numeric.has(name) ? 'number' : 'text',
        value: state.spec.options[name] ?? '',
        oninput: (e) => {
          const raw = e.target.value;
          state.spec.options[name] = numeric.has(name) ? (raw === '' ? undefined : Number(raw)) : raw;
        },
      })));

    const profileNames = state.init.profiles.map((p) => p.name);
    return h('div', null,
      h('label', { class: 'f' }, 'Data type'), typeSelect,
      h('label', { class: 'f' }, 'Locale'), localeSelect,
      optionInputs,
      h('div', { class: 'actions' },
        h('button', {
          class: 'b p', disabled: state.busy || !state.target,
          onclick: () => run(async () => {
            const r = await call('fillGenerated', { spec: state.spec });
            flash(`Filled "${preview(r.value)}"${r.truncated ? ` (cut to ${r.acceptedLength} by maxlength)` : ''}`, 'ok');
          }),
        }, 'Fill field'),
        h('button', {
          class: 'b', disabled: state.busy,
          onclick: () => run(async () => { state.preview = await call('preview', { spec: state.spec, count: 5 }); }),
        }, 'Preview 5')),
      state.preview.length ? h('ul', null, state.preview.map((v) => h('li', null,
        h('span', { class: 'grow v', title: v }, preview(v, 50)),
        h('button', {
          class: 'b', disabled: !state.target,
          onclick: () => run(async () => {
            await call('fillValue', { value: { value: v, label: catalogEntry(state.spec.type).label, kind: 'faker', technique: 'random-testing' } });
            flash(`Filled "${preview(v)}"`, 'ok');
          }),
        }, 'Fill')))) : null,
      h('h4', null, 'Save to a data profile'),
      h('div', { class: 'muted' }, 'A profile remembers which generator each field uses, so you can fill the whole form in one click.'),
      h('div', { class: 'row', style: 'margin-top:6px' },
        h('input', {
          'aria-label': 'Profile name', placeholder: 'Profile name, e.g. New customer', list: 'qa-profiles', value: state.profileName,
          oninput: (e) => { state.profileName = e.target.value; },
        }),
        h('datalist', { id: 'qa-profiles' }, profileNames.map((n) => h('option', { value: n }))),
        h('button', {
          class: 'b auto', disabled: state.busy || !state.target,
          onclick: () => run(async () => {
            state.init.profiles = await call('addToProfile', { profile: state.profileName, spec: state.spec });
            flash(`Added ${state.target.label} to "${state.profileName}"`, 'ok');
          }),
        }, 'Add field')));
  }

  function caseList(cases) {
    return h('ul', null, cases.map((c) => h('li', null,
      h('div', { class: 'grow' },
        h('div', null, c.label, ' ',
          c.expected ? h('span', { class: `badge ${c.expected}` }, c.expected) : null, ' ',
          h('span', { class: 'badge tech' }, techniqueName(c.technique))),
        h('div', { class: 'v', title: c.why || '' }, preview(c.value, 48))),
      h('button', {
        class: 'b', disabled: state.busy || !state.target,
        onclick: () => run(async () => {
          const r = await call('fillValue', { value: c, bypassMaxLength: state.bypassMaxLength });
          flash(r.truncated
            ? `Field kept ${r.acceptedLength} of ${r.requested} characters (maxlength)`
            : `Filled ${c.label}`, r.truncated ? 'info' : 'ok');
        }),
      }, 'Fill'))));
  }

  function boundaryView() {
    const r = state.range;
    const t = state.target;
    const suggested = t && t.suggestions && t.suggestions.length ? t.suggestions : null;
    const set = (key) => (e) => { r[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; };
    const kindLabels = { length: 'Text length', number: 'Number', date: 'Date' };
    return h('div', null,
      suggested ? h('div', null,
        h('h4', null, 'Suggested from this field'),
        caseList(suggested.map((c) => ({ ...c, kind: c.technique === 'equivalence-partitioning' ? 'partition' : 'boundary' })))) : null,
      h('h4', null, 'Custom range'),
      h('div', { class: 'row' },
        h('select', { 'aria-label': 'Range kind', onchange: (e) => { r.kind = e.target.value; render(); } },
          Object.entries(kindLabels).map(([k, label]) => h('option', { value: k, selected: r.kind === k }, label))),
        h('select', { 'aria-label': 'BVA mode', onchange: set('mode') },
          h('option', { value: '2-value', selected: r.mode === '2-value' }, '2-value BVA'),
          h('option', { value: '3-value', selected: r.mode === '3-value' }, '3-value BVA'))),
      h('div', { class: 'row' },
        h('div', null, h('label', { class: 'f' }, r.kind === 'length' ? 'Min length' : 'Min'),
          h('input', { 'aria-label': 'Range min', type: r.kind === 'date' ? 'date' : 'number', value: r.min, oninput: set('min') })),
        h('div', null, h('label', { class: 'f' }, r.kind === 'length' ? 'Max length' : 'Max'),
          h('input', { 'aria-label': 'Range max', type: r.kind === 'date' ? 'date' : 'number', value: r.max, oninput: set('max') })),
        r.kind === 'number' ? h('div', null, h('label', { class: 'f' }, 'Step'),
          h('input', { 'aria-label': 'Range step', type: 'number', placeholder: '1', value: r.step, oninput: set('step') })) : null,
        r.kind === 'length' ? h('div', null, h('label', { class: 'f' }, 'Characters'),
          h('select', { 'aria-label': 'Characters', onchange: set('charset') },
            ['text', 'digits', 'email'].map((c) => h('option', { value: c, selected: r.charset === c }, c)))) : null),
      r.kind !== 'date' ? h('label', { class: 'f' },
        h('input', { type: 'checkbox', checked: r.partitions, onchange: set('partitions') }), ' Add equivalence partitions') : null,
      h('label', { class: 'f' },
        h('input', { type: 'checkbox', checked: state.bypassMaxLength, onchange: (e) => { state.bypassMaxLength = e.target.checked; } }),
        ' Ignore maxlength (tests server-side validation)'),
      h('div', { class: 'actions' },
        h('button', {
          class: 'b p', disabled: state.busy,
          onclick: () => run(async () => { state.cases = await call('cases', { ...r }); }),
        }, 'Generate cases'),
        t && t.constraints ? h('button', {
          class: 'b', disabled: state.busy,
          onclick: () => {
            const c = t.constraints;
            if (c.type === 'number' || c.type === 'range') Object.assign(r, { kind: 'number', min: c.min ?? '', max: c.max ?? '', step: c.step ?? '' });
            else if (c.type === 'date') Object.assign(r, { kind: 'date', min: c.min ?? '', max: c.max ?? '' });
            else Object.assign(r, { kind: 'length', min: c.minLength ?? '', max: c.maxLength ?? '', charset: c.type === 'email' ? 'email' : c.type === 'tel' ? 'digits' : 'text' });
            render();
          },
        }, 'Use field limits') : null),
      state.cases.length ? caseList(state.cases) : null);
  }

  function edgeView() {
    return h('div', null,
      h('div', { class: 'muted' }, 'Inputs that often break forms. Tagged as error guessing in the report.'),
      caseList(state.init.edgeCases.map((c) => ({ ...c, kind: 'edge-case' }))));
  }

  function profilesView() {
    const profiles = state.init.profiles;
    if (!profiles.length) {
      return h('div', { class: 'muted' }, 'No profiles yet. On the Faker tab, pick a type for a field and choose "Add field". Repeat for each field in the form.');
    }
    return h('ul', null, profiles.map((p) => h('li', { style: 'display:block' },
      h('div', { class: 'row' },
        h('b', null, p.name),
        h('span', { class: 'muted auto' }, `${p.fields.length} fields`),
        h('button', {
          class: 'b p auto', disabled: state.busy,
          onclick: () => run(async () => {
            const r = await call('applyProfile', { profile: p.name });
            flash(r.errors.length ? `Filled ${r.filled.length}. Problems: ${r.errors.join('; ')}` : `Filled ${r.filled.length} fields`, r.errors.length ? 'error' : 'ok');
          }),
        }, 'Fill all'),
        h('button', {
          class: 'b d auto', disabled: state.busy,
          onclick: () => run(async () => { state.init.profiles = await call('deleteProfile', { profile: p.name }); }),
        }, 'Delete')),
      h('ul', null, p.fields.map((f, i) => h('li', null,
        h('span', { class: 'grow' }, f.label, ' ', h('span', { class: 'muted' }, `→ ${(catalogEntry(f.spec.type) || {}).label || f.spec.type}`)),
        h('button', {
          class: 'b', title: 'Remove field',
          onclick: () => run(async () => { state.init.profiles = await call('removeProfileField', { profile: p.name, index: i }); }),
        }, '×')))))));
  }

  function stepValueSelect(step) {
    const current = state.loop.values[step.seq];
    const selected = current ? (current.mode === 'keep' ? 'keep' : current.spec.type) : step.spec ? step.spec.type : 'keep';
    const groups = {};
    for (const c of state.init.catalog) (groups[c.group] = groups[c.group] || []).push(c);
    const select = h('select', {
      'aria-label': `Value for step ${step.seq}`,
      onchange: (e) => {
        const v = e.target.value;
        state.loop.values[step.seq] = v === 'keep'
          ? { mode: 'keep' }
          : { mode: 'generate', spec: { type: v, locale: state.spec.locale, options: v === 'template' ? { template: `${step.value || 'item'} {i}` } : {} } };
        render();
      },
    },
    h('option', { value: 'keep', selected: selected === 'keep' }, 'Keep recorded value'),
    Object.entries(groups).map(([group, items]) =>
      h('optgroup', { label: group }, items.map((c) => h('option', { value: c.id, selected: c.id === selected }, c.label)))));
    const choice = state.loop.values[step.seq];
    const needsText = choice && choice.mode === 'generate' && ['template', 'pattern', 'custom'].includes(choice.spec.type);
    const key = choice && choice.mode === 'generate' ? { template: 'template', pattern: 'pattern', custom: 'path' }[choice.spec.type] : null;
    return h('div', null, select, needsText ? h('input', {
      'aria-label': `Option for step ${step.seq}`,
      placeholder: key === 'template' ? 'e.g. Item {i} or {{commerce.productName}}' : key === 'pattern' ? 'Regex' : 'module.method',
      value: choice.spec.options[key] || '',
      oninput: (e) => { choice.spec.options[key] = e.target.value; },
    }) : null);
  }

  function loopView() {
    const c = state.capture;
    const s = state.loopStatus;
    const intro = h('div', { class: 'muted' },
      '1. Get the page to where the flow starts. 2. Start capturing and do the flow once, e.g. fill the form and click Add. ',
      '3. Finish, choose how each field gets its value, and run it as many times as you need.');
    if (c.state === 'idle') {
      return h('div', null, intro, h('div', { class: 'actions' },
        h('button', { class: 'b p', disabled: state.busy, onclick: () => run(async () => { state.capture = await call('captureStart'); }) }, 'Start capturing')));
    }
    if (c.state === 'capturing') {
      return h('div', null,
        h('div', { class: 'msg info', style: 'margin:0' }, 'Capturing. Do the flow once on the page, then press Finish.'),
        h('div', { class: 'actions' },
          h('button', { class: 'b p', disabled: state.busy, onclick: () => run(async () => { state.capture = await call('captureEnd'); }) }, 'Finish capture'),
          h('button', { class: 'b', disabled: state.busy, onclick: () => run(async () => { state.capture = await call('captureCancel'); }) }, 'Cancel')));
    }
    const running = s && s.state === 'running';
    return h('div', null,
      h('h4', null, `Captured flow (${c.steps.length} steps)`),
      h('ul', null, c.steps.map((step) => h('li', { style: 'display:block' },
        h('div', null, h('b', null, step.action), ' ', step.target,
          step.replayable ? null : h('span', { class: 'badge invalid' }, step.sensitive ? 'masked' : 'skipped')),
        step.action === 'fill' || step.action === 'select'
          ? h('div', null, h('div', { class: 'v' }, `Recorded: ${preview(step.value || '', 40)}`), step.action === 'fill' ? stepValueSelect(step) : null)
          : null))),
      h('div', { class: 'row' },
        h('div', null, h('label', { class: 'f' }, 'Iterations'),
          h('input', { 'aria-label': 'Iterations', type: 'number', min: 1, value: state.loop.iterations, oninput: (e) => { state.loop.iterations = Number(e.target.value); } })),
        h('div', null, h('label', { class: 'f' }, 'Pause between (ms)'),
          h('input', { 'aria-label': 'Pause between', type: 'number', min: 0, value: state.loop.delayMs, oninput: (e) => { state.loop.delayMs = Number(e.target.value); } }))),
      h('label', { class: 'f' },
        h('input', { type: 'checkbox', checked: state.loop.reload, onchange: (e) => { state.loop.reload = e.target.checked; } }),
        ' Reload the start page before each iteration'),
      s ? h('div', { class: `msg ${s.state === 'done' ? (s.passed === s.total ? 'ok' : 'error') : 'info'}`, style: 'margin:8px 0 0' },
        s.state === 'running'
          ? `Running iteration ${s.iteration} of ${s.total}…`
          : `${s.stopped ? 'Stopped. ' : ''}${s.passed} of ${s.total} iterations passed.`) : null,
      h('div', { class: 'actions' },
        running
          ? h('button', { class: 'b d', onclick: () => call('loopStop').catch(() => undefined) }, 'Stop')
          : h('button', {
            class: 'b p', disabled: state.busy,
            onclick: () => run(async () => {
              const r = await call('loopRun', { options: { ...state.loop } });
              const failed = r.results.filter((x) => !x.ok);
              if (failed.length) flash(`Iteration ${failed[0].iteration} failed: ${failed[0].error}`, 'error');
            }),
          }, 'Run loop'),
        h('button', { class: 'b', disabled: state.busy || running, onclick: () => run(async () => { state.capture = await call('captureCancel'); state.loopStatus = null; }) }, 'New capture')));
  }

  async function loadBugDraft() {
    const draft = await call('bugDraft', { scope: state.bugForm.scope });
    state.bug = draft;
    state.bugForm.title = draft.title;
    state.bugForm.actual = draft.actual;
    state.bugForm.techniques = draft.techniques.map((t) => t.id);
  }

  function toggleIn(list, item, on) {
    return on ? list.filter((x) => x !== item) : list.includes(item) ? list : [...list, item];
  }

  function bugStepsView() {
    const f = state.bugForm;
    const steps = state.bug.stepList || [];
    if (!steps.length) return null;
    const kept = steps.filter((s) => !f.excludeSteps.includes(s.key)).length;
    return h('div', null,
      h('h4', null, `Reproduction steps (${kept} of ${steps.length})`),
      h('div', { class: 'row', style: 'margin-bottom:4px' },
        h('span', { class: 'muted' }, 'Untick steps that are not needed to reproduce the bug.'),
        h('button', { class: 'link auto', onclick: () => { f.excludeSteps = []; render(); } }, 'All'),
        h('button', { class: 'link auto', onclick: () => { f.excludeSteps = steps.map((s) => s.key); render(); } }, 'None')),
      h('div', { class: 'pick', 'data-pick': 'steps' }, steps.map((s) => {
        const on = !f.excludeSteps.includes(s.key);
        return h('label', { class: on ? '' : 'off' },
          h('input', {
            type: 'checkbox', checked: on, 'aria-label': `Include step ${s.number}`,
            onchange: (e) => { f.excludeSteps = toggleIn(f.excludeSteps, s.key, e.target.checked); render(); },
          }),
          h('span', null, `${s.number}. ${s.text}`));
      })));
  }

  function bugShotsView() {
    const f = state.bugForm;
    const shots = state.bug.screenshots || [];
    const preview = (path) => run(async () => {
      if (state.bugPreview[path]) delete state.bugPreview[path];
      else state.bugPreview[path] = await call('bugShot', { path });
    });
    const kept = shots.filter((s) => !f.excludeScreenshots.includes(s.path) && !(s.step && f.excludeSteps.includes(s.step))).length
      + (f.pageScreenshot ? 1 : 0);
    return h('div', null,
      h('h4', null, `Screenshots (${kept} of ${shots.length + 1})`),
      shots.length ? h('div', { class: 'row', style: 'margin-bottom:4px' },
        h('span', { class: 'muted' }, 'Screenshots of left-out steps are dropped too.'),
        h('button', { class: 'link auto', onclick: () => { f.excludeScreenshots = []; f.pageScreenshot = true; render(); } }, 'All'),
        h('button', { class: 'link auto', onclick: () => { f.excludeScreenshots = shots.map((s) => s.path); f.pageScreenshot = false; render(); } }, 'None')) : null,
      h('div', { class: 'pick', 'data-pick': 'screenshots' },
        h('label', null,
          h('input', { type: 'checkbox', checked: f.pageScreenshot, 'aria-label': 'Include screenshot of the page now',
            onchange: (e) => { f.pageScreenshot = e.target.checked; render(); } }),
          h('span', null, 'The page as it is when you click Create (QA panel hidden)')),
        shots.map((s) => {
          const stepGone = s.step && f.excludeSteps.includes(s.step);
          const on = !stepGone && !f.excludeScreenshots.includes(s.path);
          return h('div', null,
            h('div', { class: 'shot' },
              h('label', { class: on ? '' : 'off' },
                h('input', {
                  type: 'checkbox', checked: on, disabled: stepGone, 'aria-label': `Include screenshot ${s.label}`,
                  onchange: (e) => { f.excludeScreenshots = toggleIn(f.excludeScreenshots, s.path, e.target.checked); render(); },
                }),
                h('span', null, s.label)),
              h('button', { class: 'link', disabled: state.busy, onclick: () => preview(s.path) }, state.bugPreview[s.path] ? 'Hide' : 'Preview')),
            state.bugPreview[s.path] ? h('img', { src: state.bugPreview[s.path], alt: s.label }) : null);
        })));
  }

  function bugView() {
    if (!state.bug) {
      return h('div', null,
        h('div', { class: 'muted' }, 'Builds a bug report from what you have recorded: steps, failed and slow API calls, console errors, screenshots and the ISTQB technique used.'),
        h('div', { class: 'actions' },
          h('button', { class: 'b p', disabled: state.busy, onclick: () => run(loadBugDraft) }, 'Start bug report')));
    }
    const f = state.bugForm;
    const d = state.bug;
    const set = (key) => (e) => { f[key] = e.target.value; };
    const detected = new Set(d.techniques.map((t) => t.id));
    const area = (key, label, rows) => h('div', null,
      h('label', { class: 'f' }, label),
      h('textarea', { 'aria-label': label, rows: rows || 3, style: 'width:100%;font:inherit;padding:5px 6px;border:1px solid #d1d5db;border-radius:6px', oninput: set(key) }, f[key]));
    return h('div', null,
      h('div', { class: 'muted' },
        `${d.steps} steps, ${d.failedApiCalls} failed API calls, ${d.slowApiCalls} slow, ${d.consoleErrors} console errors, ${d.pageErrors} JS errors`
        + `${d.a11yViolations ? `, ${d.a11yViolations} accessibility issues` : ''}${d.layoutIssues ? `, ${d.layoutIssues} layout issues` : ''}.`),
      d.hasPreviousBug ? h('div', { class: 'row', style: 'margin-top:6px' },
        h('label', { class: 'auto' }, h('input', { type: 'radio', name: 'scope', checked: f.scope === 'session',
          onchange: () => { f.scope = 'session'; run(loadBugDraft); } }), ' Whole session'),
        h('label', { class: 'auto' }, h('input', { type: 'radio', name: 'scope', checked: f.scope === 'since-last-bug',
          onchange: () => { f.scope = 'since-last-bug'; run(loadBugDraft); } }), ' Since last bug')) : null,
      h('label', { class: 'f' }, 'Title'),
      h('input', { 'aria-label': 'Bug title', value: f.title, oninput: set('title') }),
      area('expected', 'Expected result', 2),
      area('actual', 'Actual result (filled from the recording)', 4),
      h('div', { class: 'row' },
        h('div', null, h('label', { class: 'f' }, 'Severity'),
          h('select', { 'aria-label': 'Severity', onchange: set('severity') },
            ['critical', 'major', 'minor', 'trivial'].map((v) => h('option', { value: v, selected: f.severity === v }, v)))),
        h('div', null, h('label', { class: 'f' }, 'Priority'),
          h('select', { 'aria-label': 'Priority', onchange: set('priority') },
            ['high', 'medium', 'low'].map((v) => h('option', { value: v, selected: f.priority === v }, v))))),
      bugStepsView(),
      bugShotsView(),
      h('h4', null, 'ISTQB test technique'),
      h('div', null, state.init.techniques.map((t) => h('label', { style: 'display:block;font-size:12px;margin:2px 0' },
        h('input', {
          type: 'checkbox', checked: f.techniques.includes(t.id),
          onchange: (e) => {
            f.techniques = e.target.checked ? [...f.techniques, t.id] : f.techniques.filter((x) => x !== t.id);
          },
        }), ' ', t.name, detected.has(t.id) ? h('span', { class: 'muted' }, ' (detected)') : null))),
      area('notes', 'Notes (optional)', 2),
      h('div', { class: 'actions' },
        h('button', {
          class: 'b p', disabled: state.busy,
          onclick: () => run(async () => {
            const r = await call('createBug', { bug: { ...f } });
            state.lastBug = r;
            state.bug = null;
            state.bugForm = {
              ...state.bugForm, title: '', expected: '', actual: '', notes: '', scope: 'since-last-bug',
              excludeSteps: [], excludeScreenshots: [], pageScreenshot: true,
            };
            state.bugPreview = {};
            flash(`Saved "${r.title}" to ${r.html}`, 'ok');
          }),
        }, 'Create bug report'),
        h('button', { class: 'b', disabled: state.busy, onclick: () => run(loadBugDraft) }, 'Refresh from recording')));
  }

  function render() {
    if (!root) return;
    // Keep scroll positions when redrawing (e.g. ticking a box in a long list).
    const scrolls = [...root.querySelectorAll('.body, [data-pick]')].map((el) => [el.dataset.pick || 'body', el.scrollTop]);
    root.replaceChildren(h('style', null, CSS));
    const mocksOn = state.mocks.active;
    root.append(h('button', { class: `pill${mocksOn ? ' warn' : ''}`, title: 'QA recorder (Alt+Shift+D)', onclick: toggle },
      `${state.open ? 'Close QA tools' : 'QA tools'}${mocksOn ? ` · ${mocksOn} mock${mocksOn > 1 ? 's' : ''} on` : ''}`));
    if (!state.open) return;
    const tabs = [['faker', 'Faker'], ['bva', 'Boundaries'], ['edge', 'Edge cases'], ['profiles', 'Profiles'], ['loop', 'Looper'], ['mock', 'Mock'], ['a11y', 'Accessibility'], ['rwd', 'Responsive'], ['bug', 'Bug']];
    let body;
    if (!state.init) body = h('div', { class: 'muted' }, 'Loading…');
    else if (state.tab === 'faker') body = fakerView();
    else if (state.tab === 'bva') body = boundaryView();
    else if (state.tab === 'edge') body = edgeView();
    else if (state.tab === 'profiles') body = profilesView();
    else if (state.tab === 'bug') body = bugView();
    else if (state.tab === 'mock') body = mockView();
    else if (state.tab === 'a11y') body = a11yView();
    else if (state.tab === 'rwd') body = rwdView();
    else body = loopView();
    root.append(h('div', { class: 'panel', role: 'dialog', 'aria-label': 'QA recorder' },
      h('header', null, h('b', null, 'QA recorder'),
        h('span', { class: 'muted' }, state.init ? `seed ${state.init.seed}` : '')),
      targetView(),
      h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([id, label]) =>
        h('button', { class: state.tab === id ? 'on' : '', role: 'tab', onclick: () => { state.tab = id; state.message = null; render(); } }, label))),
      state.message ? h('div', { class: `msg ${state.message.kind}` }, state.message.text) : null,
      h('div', { class: 'body' }, body)));
    for (const [id, top] of scrolls) {
      const el = id === 'body' ? root.querySelector('.body') : root.querySelector(`[data-pick="${id}"]`);
      if (el) el.scrollTop = top;
    }
  }

  // ---------- API for Node ----------

  window.__qaPanelUi = {
    setTarget(target) {
      state.target = target;
      render();
    },
    mocksChanged(mocks) {
      state.mocks = mocks;
      // Don't redraw under the QA while they edit a rule.
      if (!state.mockEdit) render();
    },
    loopStatus(status) {
      state.loopStatus = status;
      render();
    },
    open() {
      if (!state.open) toggle();
    },
    /** For qa-recorder's own tests. */
    get _root() {
      return root;
    },
  };

  window.addEventListener('keydown', (event) => {
    if (event.altKey && event.shiftKey && (event.key === 'D' || event.key === 'd' || event.code === 'KeyD')) {
      event.preventDefault();
      toggle();
    }
  }, true);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
