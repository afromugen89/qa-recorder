// Injected into every page and frame by qa-recorder (via context.addInitScript).
// Plain JavaScript on purpose: it is serialized into the browser, so it must not
// depend on any build-time helpers.
(() => {
  if (window.__qaRecorder) return;

  const MAX_NAME = 80;
  /** Tag of qa-recorder's own panel. Events inside it are never recorded. */
  const UI_TAG = 'qa-recorder-panel';
  const CLOSED_ROOTS = new WeakSet();
  const CLOSED_HOSTS = new WeakSet();
  const SEEN_EVENTS = new WeakSet();
  const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];
  const TEXT_INPUT_TYPES = new Set([
    '', 'text', 'email', 'password', 'search', 'tel', 'url', 'number',
    'date', 'datetime-local', 'month', 'time', 'week', 'color', 'range',
  ]);
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'combobox',
  ]);

  // ---------- sending ----------

  function send(payload) {
    try {
      if (typeof window.__qaRecord === 'function') window.__qaRecord(payload);
    } catch (_) { /* recorder must never break the page */ }
  }

  // ---------- DOM helpers (shadow-DOM aware) ----------

  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  }

  function closestDeep(el, predicate) {
    for (let cur = el; cur; cur = parentOf(cur)) {
      if (cur.nodeType === 1 && predicate(cur)) return cur;
    }
    return null;
  }

  function shadowInfo(el) {
    let inShadow = false;
    let inClosed = false;
    for (let root = el.getRootNode(); root instanceof ShadowRoot; root = root.host.getRootNode()) {
      inShadow = true;
      if (CLOSED_ROOTS.has(root) || root.mode === 'closed') inClosed = true;
    }
    return { inShadow, inClosed };
  }

  // Walk the document, including open shadow roots (what Playwright selectors can see).
  function deepElements(root, out = []) {
    const walker = (root.ownerDocument || root).createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      if (node.localName === UI_TAG) {
        node = walker.nextSibling() || nextOutside(walker);
        continue;
      }
      out.push(node);
      if (node.shadowRoot) deepElements(node.shadowRoot, out);
      node = walker.nextNode();
    }
    return out;
  }

  function nextOutside(walker) {
    while (walker.parentNode()) {
      const sibling = walker.nextSibling();
      if (sibling) return sibling;
    }
    return null;
  }

  function normalize(text) {
    return (text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function quote(value) {
    return JSON.stringify(value);
  }

  // ---------- roles and accessible names (common cases) ----------

  function implicitRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.localName;
    if (tag === 'button') return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'option') return 'option';
    if (tag === 'summary') return 'button';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img' && el.getAttribute('alt')) return 'img';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (['', 'text', 'email', 'tel', 'url'].includes(type)) return 'textbox';
    }
    return null;
  }

  function labelText(el) {
    const parts = [];
    if (el.labels && el.labels.length) {
      for (const label of el.labels) parts.push(label.textContent);
    }
    return normalize(parts.join(' '));
  }

  function accessibleName(el) {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return normalize(ariaLabel);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const root = el.getRootNode();
      const text = labelledBy.split(/\s+/)
        .map((id) => (root.getElementById ? root.getElementById(id) : document.getElementById(id)))
        .filter(Boolean).map((n) => n.textContent).join(' ');
      if (text.trim()) return normalize(text);
    }
    const tag = el.localName;
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const fromLabel = labelText(el);
      if (fromLabel) return fromLabel;
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (['button', 'submit', 'reset'].includes(type) && el.value) return normalize(el.value);
      if (type === 'image' && el.getAttribute('alt')) return normalize(el.getAttribute('alt'));
      return normalize(el.getAttribute('title') || el.getAttribute('placeholder') || '');
    }
    if (tag === 'img') return normalize(el.getAttribute('alt') || '');
    const text = normalize(el.innerText !== undefined ? el.innerText : el.textContent);
    if (text) return text;
    return normalize(el.getAttribute('title') || '');
  }

  // ---------- locator generation ----------

  function isUnique(predicate) {
    let count = 0;
    for (const el of deepElements(document)) {
      if (predicate(el)) {
        count++;
        if (count > 1) return false;
      }
    }
    return count === 1;
  }

  function looksGenerated(value) {
    // ids like "ember123", "react-select-5-input", ":r1:", uuids, long hex
    return /\d{3,}|[0-9a-f]{8,}|^:|__/i.test(value);
  }

  function cssPath(el) {
    // Playwright CSS pierces open shadow roots, so build the path within the
    // element's own root and let the engine do the piercing.
    const segments = [];
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      let seg = cur.localName;
      if (cur.id && !looksGenerated(cur.id)) {
        segments.unshift(`#${cssEscape(cur.id)}`);
        break;
      }
      const parent = cur.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.localName === cur.localName);
        if (sameTag.length > 1) seg += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
      }
      segments.unshift(seg);
    }
    let path = segments.join(' > ');
    const root = el.getRootNode();
    if (root instanceof ShadowRoot) {
      path = `${cssPath(root.host)} ${path}`;
    }
    return path;
  }

  function buildLocator(el) {
    for (const attr of TEST_ID_ATTRS) {
      const v = el.getAttribute(attr);
      if (v && isUnique((n) => n.getAttribute(attr) === v)) {
        return {
          strategy: 'testid',
          selector: `[${attr}=${quote(v)}]`,
          code: attr === 'data-testid' ? `getByTestId(${quote(v)})` : `locator(${quote(`[${attr}=${quote(v)}]`)})`,
        };
      }
    }

    const role = implicitRole(el);
    const name = role ? accessibleName(el) : '';
    if (role && name && isUnique((n) => implicitRole(n) === role && accessibleName(n) === name)) {
      return {
        strategy: 'role',
        selector: `internal:role=${role}[name=${quote(name)}s]`,
        code: `getByRole(${quote(role)}, { name: ${quote(name)}, exact: true })`,
      };
    }

    const tag = el.localName;
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const label = labelText(el);
      if (label && isUnique((n) => n.labels && labelText(n) === label)) {
        return {
          strategy: 'label',
          selector: `internal:label=${quote(label)}s`,
          code: `getByLabel(${quote(label)}, { exact: true })`,
        };
      }
      const placeholder = el.getAttribute('placeholder');
      if (placeholder && isUnique((n) => n.getAttribute('placeholder') === placeholder)) {
        return {
          strategy: 'placeholder',
          selector: `[placeholder=${quote(placeholder)}]`,
          code: `getByPlaceholder(${quote(placeholder)}, { exact: true })`,
        };
      }
      const fieldName = el.getAttribute('name');
      if (fieldName && isUnique((n) => n.localName === tag && n.getAttribute('name') === fieldName && (!el.type || n.type === el.type))) {
        const sel = `${tag}[name=${quote(fieldName)}]`;
        return { strategy: 'css', selector: sel, code: `locator(${quote(sel)})` };
      }
    }

    if (el.id && !looksGenerated(el.id) && isUnique((n) => n.id === el.id)) {
      const sel = `#${cssEscape(el.id)}`;
      return { strategy: 'css', selector: sel, code: `locator(${quote(sel)})` };
    }

    if (role && name) {
      // Not unique: pick the nth match so replay still lands on the right element.
      const matches = deepElements(document).filter((n) => implicitRole(n) === role && accessibleName(n) === name);
      const index = matches.indexOf(el);
      if (index >= 0) {
        return {
          strategy: 'role',
          selector: `internal:role=${role}[name=${quote(name)}s] >> nth=${index}`,
          code: `getByRole(${quote(role)}, { name: ${quote(name)}, exact: true }).nth(${index})`,
        };
      }
    }

    const sel = cssPath(el);
    return { strategy: 'css', selector: sel, code: `locator(${quote(sel)})` };
  }

  function describe(el) {
    const text = normalize(el.innerText !== undefined ? el.innerText : el.textContent).slice(0, 60);
    const info = shadowInfo(el);
    return {
      tag: el.localName,
      type: el.getAttribute('type') || undefined,
      id: el.id || undefined,
      name: el.getAttribute('name') || undefined,
      role: implicitRole(el) || undefined,
      accessibleName: accessibleName(el) || undefined,
      text: text || undefined,
      inShadowDom: info.inShadow,
      inClosedShadowDom: info.inClosed,
    };
  }

  // ---------- event handling ----------

  function deepTarget(event) {
    const path = event.composedPath();
    return path.length && path[0].nodeType === 1 ? path[0] : event.target;
  }

  function isTextLike(el) {
    if (el.localName === 'textarea') return true;
    if (el.isContentEditable) return true;
    if (el.localName === 'input') return TEXT_INPUT_TYPES.has((el.getAttribute('type') || '').toLowerCase());
    return false;
  }

  function isSensitive(el) {
    if (el.localName !== 'input') return false;
    const type = (el.getAttribute('type') || '').toLowerCase();
    const auto = (el.getAttribute('autocomplete') || '').toLowerCase();
    return type === 'password' || auto.includes('password') || auto.startsWith('cc-');
  }

  function record(kind, el, extra) {
    let locator;
    try {
      locator = buildLocator(el);
    } catch (e) {
      locator = { strategy: 'css', selector: el.localName, code: `locator(${quote(el.localName)})` };
    }
    send(Object.assign({
      kind,
      locator,
      element: describe(el),
      url: location.href,
      timestamp: Date.now(),
    }, extra || {}));
  }

  // An event from inside a closed shadow root looks like it targets the host when
  // seen from outside. Skip it there; the listener on the closed root handles it.
  function isOwnUi(event) {
    return event.composedPath().some((n) => n.localName === UI_TAG);
  }

  function claim(event) {
    if (SEEN_EVENTS.has(event)) return false;
    if (CLOSED_HOSTS.has(deepTarget(event))) return false;
    if (isOwnUi(event)) return false;
    SEEN_EVENTS.add(event);
    return true;
  }

  function onClick(event) {
    if (!claim(event)) return;
    const raw = deepTarget(event);
    if (!raw || raw.nodeType !== 1) return;

    const el = closestDeep(raw, (n) => {
      const tag = n.localName;
      if (['button', 'a', 'input', 'select', 'textarea', 'label', 'summary', 'option'].includes(tag)) return true;
      const role = n.getAttribute('role');
      return !!role && INTERACTIVE_ROLES.has(role);
    }) || raw;

    if (el.localName === 'label') {
      // The browser forwards a label click to its control; record that click instead.
      if (el.control) return;
    }
    if (el.localName === 'select' || el.localName === 'option') return; // recorded on change
    if (el.localName === 'input') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'checkbox') return record(el.checked ? 'check' : 'uncheck', el);
      if (type === 'radio') return record('check', el);
      if (type === 'file') return; // recorded on change
      if (isTextLike(el)) return; // clicks into text fields are noise; the fill is recorded
    }
    if (el.localName === 'textarea') return;
    const role = el.getAttribute('role');
    if (role === 'checkbox' || role === 'switch') {
      return record(el.getAttribute('aria-checked') === 'true' ? 'uncheck' : 'check', el);
    }
    record('click', el, {
      button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left',
      modifiers: ['Alt', 'Control', 'Meta', 'Shift'].filter((m) => event.getModifierState && event.getModifierState(m)),
    });
  }

  function onDblClick(event) {
    if (!claim(event)) return;
    const el = deepTarget(event);
    if (el && el.nodeType === 1) record('dblclick', el);
  }

  function onInput(event) {
    if (!claim(event)) return;
    const el = deepTarget(event);
    if (!el || el.nodeType !== 1 || !isTextLike(el)) return;
    const value = el.isContentEditable ? el.innerText : el.value;
    record('fill', el, { value, sensitive: isSensitive(el) });
  }

  function onChange(event) {
    if (!claim(event)) return;
    const el = deepTarget(event);
    if (!el || el.nodeType !== 1) return;
    if (el.localName === 'select') {
      const selected = Array.from(el.selectedOptions);
      record('select', el, {
        values: selected.map((o) => o.value),
        labels: selected.map((o) => normalize(o.label || o.textContent)),
      });
    } else if (el.localName === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'file') {
      record('setInputFiles', el, { files: Array.from(el.files || []).map((f) => f.name) });
    }
  }

  const KEYS = new Set(['Enter', 'Escape', 'Tab']);
  function isToolsShortcut(event) {
    return event.altKey && event.shiftKey && (event.key === 'D' || event.key === 'd' || event.code === 'KeyD');
  }

  function onKeyDown(event) {
    // Alt+Shift+D brings the QA tools tab forward. It is not a test step.
    if (isToolsShortcut(event)) {
      if (SEEN_EVENTS.has(event)) return;
      SEEN_EVENTS.add(event);
      event.preventDefault();
      try {
        if (typeof window.__qaShowTools === 'function') window.__qaShowTools();
      } catch (_) { /* ignore */ }
      return;
    }
    if (!claim(event)) return;
    if (!KEYS.has(event.key)) return;
    const el = deepTarget(event);
    if (!el || el.nodeType !== 1) return;
    if (event.key === 'Enter' && el.localName === 'textarea') return;
    const mods = ['Alt', 'Control', 'Meta', 'Shift'].filter((m) => event.getModifierState(m));
    record('press', el, { key: [...mods, event.key].join('+') });
  }

  // ---------- field targeting for the test data panel ----------

  let lastField = null;

  function isFillable(el) {
    return isTextLike(el) || el.localName === 'select';
  }

  function num(value) {
    return value === null || value === '' ? undefined : Number(value);
  }

  function constraintsOf(el) {
    const attr = (name) => el.getAttribute(name) || undefined;
    const maxLength = num(el.getAttribute('maxlength'));
    const minLength = num(el.getAttribute('minlength'));
    return {
      type: el.localName === 'input' ? (attr('type') || 'text').toLowerCase() : el.localName,
      maxLength: maxLength !== undefined && maxLength >= 0 ? maxLength : undefined,
      minLength,
      min: attr('min'),
      max: attr('max'),
      step: attr('step'),
      pattern: attr('pattern'),
      required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
      options: el.localName === 'select'
        ? Array.from(el.options).map((o) => ({ value: o.value, label: normalize(o.label || o.textContent) }))
        : undefined,
    };
  }

  function onFocusIn(event) {
    if (isOwnUi(event)) return;
    const el = deepTarget(event);
    if (!el || el.nodeType !== 1 || !isFillable(el) || el === lastField) return;
    lastField = el;
    let locator;
    try {
      locator = buildLocator(el);
    } catch (_) {
      locator = { strategy: 'css', selector: el.localName, code: `locator(${quote(el.localName)})` };
    }
    try {
      if (typeof window.__qaFocus === 'function') {
        window.__qaFocus({
          locator,
          element: describe(el),
          label: accessibleName(el) || el.getAttribute('name') || el.getAttribute('placeholder') || el.localName,
          constraints: constraintsOf(el),
        });
      }
    } catch (_) { /* ignore */ }
  }

  // Set a value the way a framework expects: through the native setter, then
  // input and change events, so React, Vue and Angular all see the change.
  function setValue(el, value) {
    el.focus();
    if (el.isContentEditable) {
      el.textContent = value;
    } else if (el.localName === 'select') {
      const match = Array.from(el.options).find((o) => o.value === value || normalize(o.label) === value);
      if (!match) throw new Error(`No option "${value}"`);
      el.value = match.value;
    } else {
      const proto = el.localName === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, value);
    }
    if (el.localName !== 'select') el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  // Typing or pasting stops at maxlength, but setting .value does not. Apply the
  // limit like a real user would hit it, unless asked to bypass it (to test
  // server-side validation).
  function fillField(value, options) {
    if (!lastField || !lastField.isConnected) {
      throw new Error('Click into a field on the page first');
    }
    const el = lastField;
    let toSet = value;
    const max = el.maxLength;
    const truncated = !(options && options.bypassMaxLength) && typeof max === 'number' && max >= 0 && value.length > max;
    if (truncated) toSet = value.slice(0, max);
    setValue(el, toSet);
    const accepted = el.isContentEditable ? el.textContent : el.value;
    return { requested: value.length, accepted, acceptedLength: accepted.length, truncated };
  }

  function listen(target) {
    target.addEventListener('focusin', onFocusIn, true);
    target.addEventListener('click', onClick, true);
    target.addEventListener('dblclick', onDblClick, true);
    target.addEventListener('input', onInput, true);
    target.addEventListener('change', onChange, true);
    target.addEventListener('keydown', onKeyDown, true);
  }

  // Closed shadow roots hide their internals from document-level listeners
  // (composedPath stops at the host), so listen on them directly.
  const originalAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function attachShadow(init) {
    const root = originalAttachShadow.call(this, init);
    if (init && init.mode === 'closed') {
      CLOSED_ROOTS.add(root);
      CLOSED_HOSTS.add(this);
      listen(root);
    }
    return root;
  };

  listen(window);

  window.__qaRecorder = {
    version: 1,
    uiTag: UI_TAG,
    attachShadow: (el, init) => originalAttachShadow.call(el, init),
    selectorFor(el) {
      return buildLocator(el);
    },
    fillField,
  };
})();
