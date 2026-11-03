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
    .pill { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; background: #1f2937; color: #fff;
      border: 0; border-radius: 999px; padding: 8px 14px; font-size: 13px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
    .panel { position: fixed; right: 16px; bottom: 60px; z-index: 2147483647; width: 400px; max-width: calc(100vw - 32px);
      max-height: calc(100vh - 80px); display: flex; flex-direction: column; background: #fff; color: #111827;
      border: 1px solid #d1d5db; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.25); font-size: 13px; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid #e5e7eb; }
    header b { font-size: 14px; }
    .target { padding: 8px 12px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; font-size: 12px; color: #374151; }
    .target code { background: #eef2ff; padding: 1px 4px; border-radius: 4px; }
    .tabs { display: flex; border-bottom: 1px solid #e5e7eb; }
    .tabs button { flex: 1; border: 0; background: none; padding: 8px 4px; cursor: pointer; font-size: 12px; color: #6b7280; border-bottom: 2px solid transparent; }
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
    .msg { margin: 8px 12px; padding: 6px 8px; border-radius: 6px; font-size: 12px; }
    .msg.info { background: #eff6ff; color: #1e40af; }
    .msg.error { background: #fef2f2; color: #991b1b; }
    .msg.ok { background: #f0fdf4; color: #166534; }
    .muted { color: #6b7280; font-size: 12px; }
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
  }

  async function ensureInit() {
    if (state.init) return;
    state.init = await call('init');
    state.target = state.init.target;
    state.capture = state.init.capture;
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

  function render() {
    if (!root) return;
    root.replaceChildren(h('style', null, CSS));
    root.append(h('button', { class: 'pill', title: 'Test data (Alt+Shift+D)', onclick: toggle }, state.open ? 'Close test data' : 'Test data'));
    if (!state.open) return;
    const tabs = [['faker', 'Faker'], ['bva', 'Boundaries'], ['edge', 'Edge cases'], ['profiles', 'Profiles'], ['loop', 'Looper']];
    let body;
    if (!state.init) body = h('div', { class: 'muted' }, 'Loading…');
    else if (state.tab === 'faker') body = fakerView();
    else if (state.tab === 'bva') body = boundaryView();
    else if (state.tab === 'edge') body = edgeView();
    else if (state.tab === 'profiles') body = profilesView();
    else body = loopView();
    root.append(h('div', { class: 'panel', role: 'dialog', 'aria-label': 'Test data' },
      h('header', null, h('b', null, 'Test data'),
        h('span', { class: 'muted' }, state.init ? `seed ${state.init.seed}` : '')),
      targetView(),
      h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([id, label]) =>
        h('button', { class: state.tab === id ? 'on' : '', role: 'tab', onclick: () => { state.tab = id; state.message = null; render(); } }, label))),
      state.message ? h('div', { class: `msg ${state.message.kind}` }, state.message.text) : null,
      h('div', { class: 'body' }, body)));
  }

  // ---------- API for Node ----------

  window.__qaPanelUi = {
    setTarget(target) {
      state.target = target;
      render();
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
