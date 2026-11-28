/* global document, Node, CSS */
// =============================================================================
// Tiny XSS-safe DOM builder shared by the dashboard and the widget.
// Untrusted strings only ever become text nodes or attribute values; there is no
// HTML-string path at all. `href` is restricted to safe schemes; `style` takes an
// object set through the CSSOM (allowed under the page's CSP, unlike a style attribute).
// =============================================================================

export const SAFE_HREF = /^(https?:|mailto:|#)/i;

function props(el, attrs) {
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') Object.assign(el.style, v);
    else if (k === 'value') el.value = String(v);
    else if (k === 'href') {
      if (SAFE_HREF.test(String(v))) el.setAttribute('href', String(v));
    } else if (/^on/i.test(k)) throw new Error(`inline handler "${k}" not allowed; use on:{}`);
    else if (typeof v !== 'string' && k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

/** h('div', { class, on: { click }, dataset, ...attrs }, 'text', node, [more]) */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  props(el, attrs);
  return append(el, children);
}

export function append(el, children) {
  for (const c of [children].flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

/**
 * Replaces `el`'s children and keeps the person where they were: the focused control
 * (matched by `data-key`), its caret and the scroll offsets of keyed scrollers come back.
 */
export function mount(el, ...children) {
  const active = document.activeElement;
  const key = el.contains(active) ? active?.dataset?.key : undefined;
  const caret =
    key && typeof active.selectionStart === 'number'
      ? [active.selectionStart, active.selectionEnd]
      : null;
  const scrolls = [...el.querySelectorAll('[data-scroll]')].map((x) => [
    x.dataset.scroll,
    x.scrollLeft,
    x.scrollTop,
  ]);
  el.replaceChildren();
  append(el, children);
  for (const [k, left, top] of scrolls) {
    const x = el.querySelector(`[data-scroll="${CSS.escape(k)}"]`);
    if (x) {
      x.scrollLeft = left;
      x.scrollTop = top;
    }
  }
  if (key) {
    const again = el.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (again) {
      again.focus({ preventScroll: true });
      if (caret && typeof again.setSelectionRange === 'function') again.setSelectionRange(...caret);
    }
  }
  return el;
}
