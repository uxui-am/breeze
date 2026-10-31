/*
  dc-lite.js — маленький движок, который запускает макет Breeze в обычном браузере.
  Шаблон: разметка внутри <x-dc> с {{выражениями}}, <sc-for list as>, <sc-if value>,
  обработчиками onClick/onMouseEnter/onMouseLeave и ref.
  Логика: <script type="text/x-dc"> с классом Component extends DCLogic (renderVals, state, setState).
  При setState страница не пересоздаётся, а аккуратно обновляется (morph), поэтому
  CSS-переходы, видео и анимации продолжают работать.
*/
(function () {
  'use strict';

  // ---------- базовый класс ----------
  class DCLogic {
    constructor(props) { this.props = props || {}; this.state = this.state || {}; }
    setState(patch) {
      const p = typeof patch === 'function' ? patch(this.state || {}) : patch;
      this.state = Object.assign({}, this.state || {}, p);
      schedule();
    }
    forceUpdate() { schedule(); }
  }
  window.DCLogic = DCLogic;

  let comp, tpl, root, queued = false, handlers = [], refs = [];

  function schedule() {
    if (queued) return;
    queued = true;
    Promise.resolve().then(() => { queued = false; render(); });
  }

  // ---------- выражения ----------
  const fnCache = new Map();
  function evalExpr(expr, scope) {
    let f = fnCache.get(expr);
    if (!f) {
      try { f = new Function('__s', 'with(__s){return (' + expr + ');}'); }
      catch (e) { f = () => undefined; }
      fnCache.set(expr, f);
    }
    try { return f(scope); } catch (e) { return undefined; }
  }
  const RX = /\{\{([\s\S]+?)\}\}/g;
  const WHOLE = /^\s*\{\{([\s\S]+?)\}\}\s*$/;
  function interp(str, scope) {
    return str.replace(RX, (_, e) => {
      const v = evalExpr(e, scope);
      return v == null || v === false ? '' : String(v);
    });
  }
  function child(scope, name, val) {
    const s = Object.create(scope);
    s[name] = val;
    return s;
  }

  // ---------- сборка DOM из шаблона ----------
  const EVENTS = { onclick: 'click', onmouseenter: 'mouseenter', onmouseleave: 'mouseleave',
    oninput: 'input', onchange: 'change', onkeydown: 'keydown', onsubmit: 'submit',
    onfocus: 'focus', onblur: 'blur', onmouseover: 'mouseover', onmouseout: 'mouseout' };

  const BOOL_ATTRS = new Set(['disabled', 'checked', 'selected', 'hidden', 'readonly', 'required',
    'multiple', 'autoplay', 'muted', 'loop', 'controls', 'playsinline', 'open', 'inert', 'autofocus', 'novalidate']);

  function build(node, scope, out) {
    if (node.nodeType === 3) { // текст
      const t = node.nodeValue;
      out.appendChild(document.createTextNode(t.indexOf('{{') < 0 ? t : interp(t, scope)));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();

    if (tag === 'sc-for') {
      const listExpr = (node.getAttribute('list') || '').match(WHOLE);
      const as = node.getAttribute('as') || 'item';
      const list = listExpr ? evalExpr(listExpr[1], scope) : null;
      if (Array.isArray(list)) list.forEach((item, i) => {
        const s = child(child(scope, as, item), as + 'Index', i);
        node.childNodes.forEach(c => build(c, s, out));
      });
      return;
    }
    if (tag === 'sc-if') {
      const m = (node.getAttribute('value') || '').match(WHOLE);
      if (m && evalExpr(m[1], scope)) node.childNodes.forEach(c => build(c, scope, out));
      return;
    }

    const isSvg = node.namespaceURI === 'http://www.w3.org/2000/svg';
    const el = isSvg ? document.createElementNS(node.namespaceURI, node.tagName) : document.createElement(tag);
    for (const a of Array.from(node.attributes)) {
      const name = a.name, val = a.value, low = name.toLowerCase();
      if (low.startsWith('hint-')) continue;
      if (EVENTS[low]) {
        const m = val.match(WHOLE);
        const fn = m ? evalExpr(m[1], scope) : null;
        if (typeof fn === 'function') {
          handlers.push(fn);
          el.setAttribute('data-dc-' + EVENTS[low], String(handlers.length - 1));
        }
        continue;
      }
      if (low === 'ref') {
        const m = val.match(WHOLE);
        const fn = m ? evalExpr(m[1], scope) : null;
        if (typeof fn === 'function') { refs.push(fn); el.setAttribute('data-dc-ref', String(refs.length - 1)); }
        continue;
      }
      if (val.indexOf('{{') < 0) { el.setAttribute(name, val); continue; }
      const m = val.match(WHOLE);
      if (m) {
        const v = evalExpr(m[1], scope);
        if (v == null) continue;
        if (BOOL_ATTRS.has(low)) { if (v) el.setAttribute(name, ''); continue; } // disabled, checked…
        el.setAttribute(name, String(v));                // data-on="true"/"false" и т. п.
      } else {
        el.setAttribute(name, interp(val, scope));
      }
    }
    const src = tag === 'template' ? node.content : node;
    src.childNodes.forEach(c => build(c, scope, el));
    out.appendChild(el);
  }

  // ---------- аккуратное обновление живой страницы ----------
  function sameKind(a, b) {
    return a.nodeType === b.nodeType && (a.nodeType !== 1 || a.tagName === b.tagName);
  }
  function syncAttrs(live, next) {
    for (const a of Array.from(live.attributes)) if (!next.hasAttribute(a.name)) live.removeAttribute(a.name);
    for (const a of Array.from(next.attributes)) if (live.getAttribute(a.name) !== a.value) live.setAttribute(a.name, a.value);
    // значения полей ввода
    if ('value' in next && live.value !== next.value && (live.tagName === 'INPUT' || live.tagName === 'TEXTAREA' || live.tagName === 'SELECT')) {
      if (document.activeElement !== live) live.value = next.getAttribute('value') || '';
    }
  }
  function morph(live, next) {
    const ln = Array.from(live.childNodes), nn = Array.from(next.childNodes);
    for (let i = 0; i < nn.length; i++) {
      const n = nn[i], l = ln[i];
      if (!l) { live.appendChild(n); continue; }
      if (!sameKind(l, n)) { live.replaceChild(n, l); continue; }
      if (l.nodeType === 3 || l.nodeType === 8) { if (l.nodeValue !== n.nodeValue) l.nodeValue = n.nodeValue; continue; }
      syncAttrs(l, n);
      morph(l, n);
    }
    for (let i = nn.length; i < ln.length; i++) live.removeChild(ln[i]);
  }

  // делегированные события
  function wire() {
    ['click', 'input', 'change', 'keydown', 'submit', 'focus', 'blur', 'mouseover', 'mouseout'].forEach(type => {
      root.addEventListener(type, e => {
        let t = e.target;
        while (t && t !== root.parentNode) {
          const id = t.getAttribute && t.getAttribute('data-dc-' + type);
          if (id != null && handlers[id]) { handlers[id](e); if (type === 'click' && t.tagName === 'A' && (t.getAttribute('href') || '') === '#') e.preventDefault(); break; }
          t = t.parentNode;
        }
      }, type === 'focus' || type === 'blur');
    });
    // mouseenter / mouseleave не всплывают — эмулируем через mouseover/mouseout
    const hover = (type, e) => {
      let t = e.target;
      const rel = e.relatedTarget;
      while (t && t !== root.parentNode) {
        const id = t.getAttribute && t.getAttribute('data-dc-' + type);
        if (id != null && handlers[id] && !(rel && t.contains(rel))) handlers[id](e);
        t = t.parentNode;
      }
    };
    root.addEventListener('mouseover', e => hover('mouseenter', e));
    root.addEventListener('mouseout', e => hover('mouseleave', e));
  }

  function render() {
    handlers = []; refs = [];
    let vals;
    try { vals = comp.renderVals() || {}; } catch (e) { console.error('[dc-lite] renderVals:', e); return; }
    const frag = document.createElement('div');
    tpl.childNodes.forEach(c => build(c, vals, frag));
    morph(root, frag);
    root.querySelectorAll('[data-dc-ref]').forEach(el => {
      const fn = refs[el.getAttribute('data-dc-ref')];
      if (fn && el.__dcRef !== fn) { el.__dcRef = fn; fn(el); }
    });
  }

  // ---------- запуск ----------
  function boot() {
    const host = document.querySelector('x-dc');
    const script = document.querySelector('script[type="text/x-dc"]');
    if (!host || !script) return;

    // шаблон лежит внутри <template>, чтобы браузер не грузил картинки с {{...}}
    // (храним его в «пустом» документе: там картинки и видео не загружаются)
    const inert = document.implementation.createHTMLDocument('');
    tpl = inert.createElement('div');
    const t = host.querySelector(':scope > template');
    const srcNodes = t ? Array.from(t.content.childNodes) : Array.from(host.childNodes);
    srcNodes.forEach(n => tpl.appendChild(inert.importNode(n, true)));

    // <helmet> → в <head> (стили и шрифты)
    const helmet = tpl.querySelector('helmet');
    if (helmet) {
      Array.from(helmet.childNodes).forEach(n => {
        if (n.nodeType === 1 && n.tagName === 'SCRIPT') { const s = document.createElement('script'); for (const a of n.attributes) s.setAttribute(a.name, a.value); s.textContent = n.textContent; document.head.appendChild(s); }
        else document.head.appendChild(n);
      });
      helmet.remove();
    }

    // на место шаблона ставим живой корень
    root = document.createElement('div');
    root.id = 'dc-root';
    host.replaceWith(root);

    // значения настроек по умолчанию (data-props)
    const props = {};
    try {
      const meta = JSON.parse(script.getAttribute('data-props') || '{}');
      for (const k in meta) if (k[0] !== '$' && meta[k] && 'default' in meta[k]) props[k] = meta[k].default;
    } catch (e) {}

    const Component = new Function('DCLogic', script.textContent + '\n;return Component;')(DCLogic);
    comp = new Component(props);
    if (!comp.state) comp.state = {};
    wire();
    render();
    if (typeof comp.componentDidMount === 'function') comp.componentDidMount();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
