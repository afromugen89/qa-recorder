// qa-recorder page checks. Injected on demand (not at page load) into the top
// frame when the QA runs an accessibility or layout check. Plain JavaScript.
// Finds layout problems (sideways scrolling, elements sticking out, small or
// overlapping tap targets, tiny text, zoom blocked) and draws numbered boxes
// over problem elements for the evidence screenshot.
(() => {
  if (window.__qaAudit) return;

  const PANEL_TAG = 'qa-recorder-panel';
  const OVERLAY_TAG = 'qa-recorder-overlay';
  const INTERACTIVE = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]', '[role=switch]',
    '[role=menuitem]', '[role=option]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  function isOurs(el) {
    for (let node = el; node; node = node.parentNode || node.host) {
      if (node.nodeType === 1 && (node.localName === PANEL_TAG || node.localName === OVERLAY_TAG)) return true;
    }
    return false;
  }

  /** Every element, including those in open shadow roots. */
  function allElements(root) {
    const out = [];
    const visit = (scope) => {
      for (const el of scope.querySelectorAll('*')) {
        if (el.localName === PANEL_TAG || el.localName === OVERLAY_TAG) continue;
        out.push(el);
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(root || document);
    return out;
  }

  function isVisible(el, rect) {
    if (rect.width < 1 || rect.height < 1) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
    // Common "visually hidden" pattern for screen-reader-only text.
    if (s.position === 'absolute' && (s.clip === 'rect(0px, 0px, 0px, 0px)' || s.clipPath === 'inset(50%)')) return false;
    return true;
  }

  function describe(el) {
    try {
      const recorder = window.__qaRecorder;
      if (recorder) return recorder.selectorFor(el).code;
    } catch (_) {
      /* fall through */
    }
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    return `${el.localName}${id}${cls}`;
  }

  function pageBox(rect) {
    return { x: Math.round(rect.left + scrollX), y: Math.round(rect.top + scrollY), w: Math.round(rect.width), h: Math.round(rect.height) };
  }

  function contains(a, b) {
    for (let node = b; node; node = node.parentNode || node.host) if (node === a) return true;
    return false;
  }

  /** True when an ancestor clips horizontally, so the overflow can't widen the page. */
  function clippedByAncestor(el) {
    for (let node = el.parentElement || (el.getRootNode() && el.getRootNode().host); node && node !== document.documentElement && node !== document.body;
      node = node.parentElement || (node.getRootNode() && node.getRootNode().host)) {
      const s = getComputedStyle(node);
      if (s.overflowX !== 'visible' || s.contain.includes('paint')) return true;
      if (s.position === 'fixed') return false;
    }
    return false;
  }

  function metaViewportIssues() {
    const issues = [];
    const meta = document.querySelector('meta[name="viewport" i]');
    if (!meta) {
      issues.push({
        kind: 'meta-viewport', severity: 'error',
        message: 'No <meta name="viewport"> tag. Phones show the desktop layout zoomed out.',
      });
      return issues;
    }
    const content = (meta.getAttribute('content') || '').toLowerCase().replace(/\s+/g, '');
    const parts = Object.fromEntries(content.split(/[,;]/).filter(Boolean).map((p) => p.split('=')));
    if (parts.width !== 'device-width') {
      issues.push({ kind: 'meta-viewport', severity: 'warning', message: `The viewport meta tag sets width=${parts.width || '(none)'} instead of width=device-width.` });
    }
    if (parts['user-scalable'] === 'no' || parts['user-scalable'] === '0' || (parts['maximum-scale'] && Number(parts['maximum-scale']) < 2)) {
      issues.push({
        kind: 'zoom-disabled', severity: 'error',
        message: `Pinch zoom is blocked (${meta.getAttribute('content')}). Users must be able to zoom to 200% (WCAG 1.4.4).`,
      });
    }
    return issues;
  }

  /**
   * Layout checks for the current viewport.
   * options.mobile: also check tap targets, text size and the viewport meta tag.
   */
  function check(options) {
    const opts = Object.assign({ mobile: false, minTarget: 24, minFont: 12, limit: 15 }, options || {});
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const pageWidth = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
    const pageHeight = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    const issues = [];
    const elements = allElements();
    const rects = new Map();
    const rectOf = (el) => {
      if (!rects.has(el)) rects.set(el, el.getBoundingClientRect());
      return rects.get(el);
    };

    // 1. Sideways scrolling and the elements that cause it.
    const scrollsSideways = pageWidth > vw + 1;
    if (scrollsSideways) {
      issues.push({
        kind: 'horizontal-scroll', severity: 'error',
        message: `The page scrolls sideways: content is ${pageWidth} px wide in a ${vw} px viewport.`,
      });
    }
    const overflowing = [];
    for (const el of elements) {
      const r = rectOf(el);
      if (r.right <= vw + 1 && r.left >= -1) continue;
      if (!isVisible(el, r) || r.width <= 1 || r.height <= 1) continue;
      // Entirely off-screen without causing a scrollbar: hidden on purpose (off-canvas menu, skip link).
      if (!scrollsSideways && (r.left >= vw || r.right <= 0)) continue;
      if (r.right <= 0) continue; // off to the left never widens the page
      if (clippedByAncestor(el)) continue;
      overflowing.push(el);
    }
    // Report only the outermost element of each overflowing subtree.
    const outermost = overflowing.filter((el) => !overflowing.some((other) => other !== el && contains(other, el)));
    for (const el of outermost.slice(0, opts.limit)) {
      const r = rectOf(el);
      const past = Math.round(r.right - vw);
      issues.push({
        kind: 'overflow', severity: scrollsSideways ? 'error' : 'warning', target: describe(el), box: pageBox(r),
        message: past > 0
          ? `${describe(el)} sticks out ${past} px past the right edge (${Math.round(r.width)} px wide)${scrollsSideways ? '' : ' and is cut off'}.`
          : `${describe(el)} starts ${Math.round(-r.left)} px left of the screen.`,
      });
    }
    if (outermost.length > opts.limit) {
      issues.push({ kind: 'overflow', severity: 'warning', message: `${outermost.length - opts.limit} more elements stick out of the viewport.` });
    }

    if (opts.mobile) {
      // 2. Tap targets smaller than 24x24 CSS px (WCAG 2.5.8 Target Size, Minimum).
      const targets = [];
      for (const el of elements) {
        if (!el.matches(INTERACTIVE) || el.disabled) continue;
        const r = rectOf(el);
        if (!isVisible(el, r)) continue;
        targets.push(el);
      }
      const undersized = targets.filter((el) => {
        const r = rectOf(el);
        return r.width < opts.minTarget || r.height < opts.minTarget;
      });
      const radius = opts.minTarget / 2;
      const centre = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      const distanceToRect = (p, r) => Math.hypot(Math.max(r.left - p.x, 0, p.x - r.right), Math.max(r.top - p.y, 0, p.y - r.bottom));
      // WCAG 2.5.8 spacing exception: a 24 px circle centred on the target must not touch
      // another target or another undersized target's circle.
      const crowded = (el) => {
        const c = centre(rectOf(el));
        for (const other of targets) {
          if (other === el || contains(other, el) || contains(el, other)) continue;
          const ro = rectOf(other);
          if (distanceToRect(c, ro) < radius) return true;
          if (undersized.includes(other)) {
            const co = centre(ro);
            if (Math.hypot(c.x - co.x, c.y - co.y) < opts.minTarget) return true;
          }
        }
        return false;
      };
      const small = [];
      for (const el of undersized) {
        const r = rectOf(el);
        if (!crowded(el)) continue;
        const s = getComputedStyle(el);
        // Links inside a sentence are exempt in WCAG 2.5.8.
        if (el.localName === 'a' && s.display === 'inline' && el.parentElement && el.parentElement.textContent.trim().length > el.textContent.trim().length + 10) continue;
        // A checkbox or radio is fine when its label is a big enough target.
        if (el.labels && [...el.labels].some((l) => { const lr = l.getBoundingClientRect(); return lr.width >= opts.minTarget && lr.height >= opts.minTarget; })) continue;
        if (el.localName === 'input' && el.closest('label')) {
          const lr = el.closest('label').getBoundingClientRect();
          if (lr.width >= opts.minTarget && lr.height >= opts.minTarget) continue;
        }
        small.push(el);
      }
      for (const el of small.slice(0, opts.limit)) {
        const r = rectOf(el);
        issues.push({
          kind: 'small-target', severity: 'warning', target: describe(el), box: pageBox(r),
          message: `${describe(el)} is ${Math.round(r.width)}×${Math.round(r.height)} px and close to other targets. Tap targets should be at least ${opts.minTarget}×${opts.minTarget} px or spaced apart (WCAG 2.5.8).`,
        });
      }
      if (small.length > opts.limit) issues.push({ kind: 'small-target', severity: 'warning', message: `${small.length - opts.limit} more tap targets are too small.` });

      // 3. Tap targets that overlap each other.
      const pool = targets.slice(0, 400);
      let overlaps = 0;
      for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
          const a = pool[i];
          const b = pool[j];
          if (contains(a, b) || contains(b, a)) continue;
          if (a.labels && [...a.labels].some((l) => contains(l, b))) continue;
          if (b.labels && [...b.labels].some((l) => contains(l, a))) continue;
          const ra = rectOf(a);
          const rb = rectOf(b);
          const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
          const hgt = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
          if (w < 4 || hgt < 4) continue;
          overlaps++;
          if (overlaps <= opts.limit) {
            issues.push({
              kind: 'overlap', severity: 'error', target: describe(a), box: pageBox(ra),
              message: `${describe(a)} and ${describe(b)} overlap (${Math.round(w)}×${Math.round(hgt)} px), so a tap can hit the wrong one.`,
            });
          }
        }
      }

      // 4. Text too small to read on a phone.
      const tiny = [];
      for (const el of elements) {
        const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!hasText) continue;
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size >= opts.minFont) continue;
        const r = rectOf(el);
        if (!isVisible(el, r)) continue;
        tiny.push({ el, size });
      }
      if (tiny.length) {
        const examples = tiny.slice(0, 3).map((t) => `${describe(t.el)} (${t.size}px)`).join(', ');
        issues.push({
          kind: 'small-text', severity: 'warning', target: describe(tiny[0].el), box: pageBox(rectOf(tiny[0].el)),
          message: `${tiny.length} text element${tiny.length > 1 ? 's use' : ' uses'} a font smaller than ${opts.minFont}px, e.g. ${examples}.`,
        });
      }

      // 5. The viewport meta tag.
      issues.push(...metaViewportIssues());
    }

    return { viewportWidth: vw, viewportHeight: vh, pageWidth, pageHeight, issues };
  }

  /** Finds an element from an axe-core target (selectors per frame; arrays for shadow DOM). */
  function resolveTarget(target) {
    let doc = document;
    let offsetX = 0;
    let offsetY = 0;
    for (let i = 0; i < target.length; i++) {
      const part = Array.isArray(target[i]) ? target[i] : [target[i]];
      let scope = doc;
      let el = null;
      for (const selector of part) {
        try {
          el = scope.querySelector(selector);
        } catch (_) {
          el = null;
        }
        if (!el) return null;
        scope = el.shadowRoot || el;
      }
      if (i === target.length - 1) return { el, offsetX, offsetY };
      // An iframe: go inside if we can, otherwise point at the iframe.
      const r = el.getBoundingClientRect();
      let inner = null;
      try {
        inner = el.contentDocument;
      } catch (_) {
        inner = null;
      }
      if (!inner) return { el, offsetX, offsetY, frameOnly: true };
      offsetX += r.left + el.clientLeft;
      offsetY += r.top + el.clientTop;
      doc = inner;
    }
    return null;
  }

  /** Page-coordinate boxes for axe-core targets. */
  function boxesFor(items) {
    const out = [];
    for (const item of items) {
      const found = resolveTarget(item.target);
      if (!found) continue;
      const r = found.el.getBoundingClientRect();
      if (r.width < 1 && r.height < 1) continue;
      out.push({
        x: Math.round(r.left + found.offsetX + scrollX),
        y: Math.round(r.top + found.offsetY + scrollY),
        w: Math.max(4, Math.round(r.width)),
        h: Math.max(4, Math.round(r.height)),
        label: item.label,
        color: item.color,
      });
    }
    return out;
  }

  let overlayHost = null;
  function overlay(boxes) {
    clearOverlay();
    overlayHost = document.createElement(OVERLAY_TAG);
    const attach = window.__qaRecorder && window.__qaRecorder.attachShadow;
    const root = attach ? attach(overlayHost, { mode: 'open' }) : overlayHost.attachShadow({ mode: 'open' });
    const height = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    const width = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
    overlayHost.setAttribute('style', `all: initial; position: absolute; left: 0; top: 0; width: ${width}px; height: ${height}px; pointer-events: none; z-index: 2147483646;`);
    const html = boxes.map((b) => {
      const color = b.color || '#dc2626';
      return `<div style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;outline:3px solid ${color};outline-offset:1px;background:${color}1a"></div>`
        + (b.label ? `<div style="position:absolute;left:${Math.max(0, b.x - 2)}px;top:${Math.max(0, b.y - 18)}px;background:${color};color:#fff;font:bold 11px/16px system-ui,sans-serif;padding:0 5px;border-radius:3px">${String(b.label).replace(/[<&]/g, '')}</div>` : '');
    }).join('');
    root.innerHTML = html;
    document.documentElement.append(overlayHost);
    return boxes.length;
  }

  function clearOverlay() {
    if (overlayHost) overlayHost.remove();
    overlayHost = null;
  }

  let highlightTimer;
  /** Scrolls to an axe-core target and outlines it for a few seconds. */
  function highlight(target, label) {
    const found = resolveTarget(target);
    if (!found) return false;
    found.el.scrollIntoView({ block: 'center', inline: 'nearest' });
    clearTimeout(highlightTimer);
    overlay(boxesFor([{ target, label }]));
    highlightTimer = setTimeout(clearOverlay, 4000);
    return true;
  }

  /** @media conditions from every stylesheet this page can read, plus the URLs of those it can't. */
  function mediaQueries() {
    const media = [];
    const unreadable = [];
    const walk = (rules) => {
      for (const rule of rules) {
        if (rule.media && rule.conditionText !== undefined && rule.cssRules) {
          media.push(rule.conditionText || rule.media.mediaText);
          walk(rule.cssRules);
        } else if (rule.styleSheet) {
          visitSheet(rule.styleSheet);
        } else if (rule.cssRules) {
          walk(rule.cssRules);
        }
      }
    };
    const visitSheet = (sheet) => {
      if (sheet.media && sheet.media.mediaText) media.push(sheet.media.mediaText);
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (_) {
        if (sheet.href) unreadable.push(sheet.href);
        return;
      }
      walk(rules);
    };
    const sheets = [...document.styleSheets];
    const addShadowSheets = (scope) => {
      for (const el of scope.querySelectorAll('*')) {
        if (el.shadowRoot && !isOurs(el)) {
          sheets.push(...el.shadowRoot.styleSheets, ...(el.shadowRoot.adoptedStyleSheets || []));
          addShadowSheets(el.shadowRoot);
        }
      }
    };
    addShadowSheets(document);
    sheets.push(...(document.adoptedStyleSheets || []));
    for (const sheet of sheets) visitSheet(sheet);
    return { media, unreadable };
  }

  /** Runs axe-core (already injected) with the given WCAG tags and returns plain data. */
  async function runAxe(args) {
    const axe = window.axe;
    // Not every version/level pair has rules (e.g. there is no wcag22a tag).
    const known = new Set(axe.getRules().flatMap((r) => r.tags));
    const result = await axe.run(
      { exclude: [[PANEL_TAG], [OVERLAY_TAG]] },
      { runOnly: { type: 'tag', values: args.tags.filter((t) => known.has(t)) }, resultTypes: ['violations', 'incomplete'], iframes: args.iframes,
        // axe would otherwise fetch the stylesheets itself, and those requests would land in the recording.
        preload: false },
    );
    const pick = (list) => list.map((r) => ({
      id: r.id, impact: r.impact, help: r.help, description: r.description, helpUrl: r.helpUrl, tags: r.tags,
      nodes: r.nodes.map((n) => ({ target: n.target, html: n.html, failureSummary: n.failureSummary })),
    }));
    return { url: location.href, violations: pick(result.violations), incomplete: pick(result.incomplete), passes: result.passes.length };
  }

  window.__qaAudit = { check, boxesFor, overlay, clearOverlay, highlight, mediaQueries, runAxe };
})();
