/* ==========================================================================
   tools/shim/dom.mjs — a tiny DOM + Canvas2D implementation, just enough to
   boot the real app under Node so the smoke test can exercise it.
   (Development tooling only — the app itself has no dependencies.)
   ========================================================================== */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);

let idCounter = 0;

/* ------------------------------------------------------------------ parser */
const TOKEN = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/([a-zA-Z0-9:_-]+)\s*>|<([a-zA-Z0-9:_-]+)((?:\s+[^\s/>"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s">]+))?)*)\s*(\/?)>/g;
const ATTR = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+)))?/g;

function parseFragment(html, doc) {
  const frag = doc.createElement('#fragment');
  const stack = [frag];
  TOKEN.lastIndex = 0;
  let last = 0, m;
  while ((m = TOKEN.exec(html)) !== null) {
    const text = html.slice(last, m.index);
    if (text.trim()) stack[stack.length - 1].appendChild(doc.createTextNode(text));
    last = TOKEN.lastIndex;
    if (m[0].startsWith('<!--') || m[0].startsWith('<!')) continue;
    if (m[1]) {                                     /* closing tag */
      const tag = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName.toLowerCase() === tag) { stack.length = i; break; }
      }
      continue;
    }
    const tag = m[2].toLowerCase();
    const el = doc.createElement(tag);
    if (m[3]) {
      ATTR.lastIndex = 0;
      let a;
      while ((a = ATTR.exec(m[3])) !== null) {
        const value = a[2] !== undefined ? a[2] : (a[3] !== undefined ? a[3] : (a[4] !== undefined ? a[4] : ''));
        el.setAttribute(a[1], value);
      }
    }
    stack[stack.length - 1].appendChild(el);
    if (!VOID.has(tag) && !m[4]) stack.push(el);
  }
  const tail = html.slice(last);
  if (tail.trim()) stack[stack.length - 1].appendChild(doc.createTextNode(tail));
  return frag;
}

/* ------------------------------------------------------------------ events */
class EventTargetShim {
  constructor() { this._listeners = {}; }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    const l = this._listeners[type];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    ev.currentTarget = this;
    ev.preventDefault = ev.preventDefault || function () { ev.defaultPrevented = true; };
    ev.stopPropagation = ev.stopPropagation || function () { ev._stopped = true; };
    const l = this._listeners[ev.type];
    if (l) for (const fn of l.slice()) { fn.call(this, ev); if (ev._stopped) break; }
    /* shallow bubbling so delegated/document handlers behave like a browser */
    if (!ev._stopped && this.parentNode && this.parentNode.dispatchEvent &&
        ['click', 'keydown', 'change', 'input', 'pointerdown', 'pointermove', 'pointerup'].includes(ev.type)) {
      this.parentNode.dispatchEvent(ev);
    }
    return !ev.defaultPrevented;
  }
  click() { this.dispatchEvent({ type: 'click' }); }
}

/* ----------------------------------------------------------------- element */
class Node extends EventTargetShim {
  constructor(doc) { super(); this.ownerDocument = doc; this.childNodes = []; this.parentNode = null; }
  get children() { return this.childNodes.filter((n) => n instanceof Element); }
  get childElementCount() { return this.children.length; }
  get firstChild() { return this.childNodes[0] || null; }
  appendChild(child) {
    if (child instanceof TextNode && child.data === '') return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) { this.childNodes.splice(i, 1); child.parentNode = null; }
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) {
    this.childNodes.slice().forEach((n) => { n.parentNode = null; });
    this.childNodes = [];
    if (v !== '' && v !== null && v !== undefined) this.appendChild(new TextNode(this.ownerDocument, String(v)));
  }
  querySelectorAll(sel) { return queryAll(this, sel); }
  querySelector(sel) { return queryAll(this, sel)[0] || null; }
  closest(sel) {
    let node = this;
    while (node) { if (node instanceof Element && matchesSelector(node, sel)) return node; node = node.parentNode; }
    return null;
  }
}

class TextNode extends Node {
  constructor(doc, data) { super(doc); this.data = data; this.nodeType = 3; this.tagName = '#text'; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class Element extends Node {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.localName = tag.toLowerCase();
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this._classes = new Set();
    this._value = ['input', 'select', 'option', 'textarea'].indexOf(this.localName) >= 0 ? '' : undefined;
    this.checked = false;
    this.disabled = false;
    this.files = [];
    this.scrollTop = 0;
    this._uid = ++idCounter;
    const self = this;
    this.classList = {
      add: (...c) => c.forEach((x) => self._classes.add(x)),
      remove: (...c) => c.forEach((x) => self._classes.delete(x)),
      contains: (c) => self._classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !self._classes.has(c) : !!force;
        if (on) self._classes.add(c); else self._classes.delete(c);
        return on;
      }
    };
  }
  get value() { return this._value; }
  set value(v) {
    this._value = this._value === undefined ? v : (v === null || v === undefined ? '' : String(v));
  }
  get className() { return [...this._classes].join(' '); }
  set className(v) {
    this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = value;
    if (name === 'id') this.id = String(value);
    if (name === 'value' && this.localName !== 'option') this.value = String(value);
    if (name === 'checked') this.checked = true;
    if (name === 'disabled') this.disabled = true;
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(value);
  }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); }
  removeAttribute(name) { delete this.attributes[name]; }
  set innerHTML(html) {
    this.childNodes.slice().forEach((n) => { n.parentNode = null; });
    this.childNodes = [];
    const frag = parseFragment(String(html), this.ownerDocument);
    frag.childNodes.slice().forEach((n) => this.appendChild(n));
  }
  get innerHTML() { return serialize(this).replace(/^<[^>]+>|<\/[^>]+>$/g, ''); }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() {
    const size = SIZE_MAP[this.localName] || (this.localName === 'canvas' ? { width: 640, height: 190 } : { width: 640, height: 24 });
    return { left: 0, top: 0, right: size.width, bottom: size.height, width: size.width, height: size.height, x: 0, y: 0 };
  }
  getContext(kind) {
    if (kind !== '2d') return null;
    if (!this._ctx) this._ctx = makeCanvas2D(this);
    return this._ctx;
  }
  get clientWidth() { return this.getBoundingClientRect().width; }
  get clientHeight() { return this.getBoundingClientRect().height; }
}

const SIZE_MAP = { canvas: { width: 640, height: 190 } };

function serialize(el) {
  if (el instanceof TextNode) return el.data;
  const attrs = Object.keys(el.attributes).map((k) => ` ${k}="${el.attributes[k]}"`).join('');
  const inner = el.childNodes.map(serialize).join('');
  return `<${el.localName}${attrs}>${inner}</${el.localName}>`;
}

/* ---------------------------------------------------------------- selectors */
function parseSimple(sel) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([#.]?)([^\s#.[]+)|\[([^\]=]+)(?:=["']?([^\]"']+)["']?)?\]/g;
  let m;
  while ((m = re.exec(sel)) !== null) {
    if (m[3] !== undefined) { out.attrs.push([m[3], m[4]]); continue; }
    const body = m[2];
    if (m[1] === '#') out.id = body;
    else if (m[1] === '.') out.classes.push(body);
    else out.tag = body.toLowerCase();
  }
  return out;
}

function matchesSimple(el, simple) {
  if (!(el instanceof Element)) return false;
  if (simple.tag && simple.tag !== '*' && el.localName !== simple.tag && el.tagName.toLowerCase() !== simple.tag) return false;
  if (simple.id && el.getAttribute('id') !== simple.id) return false;
  for (const c of simple.classes) if (!el._classes.has(c)) return false;
  for (const [k, v] of simple.attrs) {
    const av = el.getAttribute(k);
    if (av === null) return false;
    if (v !== undefined && av !== v) return false;
  }
  return true;
}

function matchesSelector(el, sel) {
  return String(sel).split(',').some((part) => {
    const parts = part.trim().split(/\s+/).map(parseSimple);
    let i = parts.length - 1;
    if (!matchesSimple(el, parts[i])) return false;
    let node = el.parentNode;
    i--;
    while (i >= 0) {
      let found = false;
      while (node) {
        if (matchesSimple(node, parts[i])) { node = node.parentNode; found = true; i--; break; }
        node = node.parentNode;
      }
      if (!found) return false;
    }
    return true;
  });
}

function queryAll(rootEl, sel) {
  const out = [];
  (function walk(node) {
    for (const child of node.childNodes) {
      if (child instanceof Element) {
        if (matchesSelector(child, sel)) out.push(child);
        walk(child);
      }
    }
  })(rootEl);
  return out;
}

/* ------------------------------------------------------------------- canvas */
function makeCanvas2D(canvas) {
  const calls = { count: 0, byName: {} };
  const noop = (name) => function () { calls.count++; calls.byName[name] = (calls.byName[name] || 0) + 1; };
  const ctx = {
    canvas,
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '10px sans-serif',
    textAlign: 'start', textBaseline: 'alphabetic', globalAlpha: 1, lineJoin: 'miter',
    lineCap: 'butt', shadowColor: 'transparent', shadowBlur: 0, globalCompositeOperation: 'source-over'
  };
  ['clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc',
    'arcTo', 'quadraticCurveTo', 'bezierCurveTo', 'rect', 'roundRect', 'fill', 'stroke', 'clip',
    'save', 'restore', 'translate', 'scale', 'rotate', 'setTransform', 'resetTransform',
    'setLineDash', 'getLineDash', 'drawImage', 'putImageData', 'fillText', 'strokeText',
    'ellipse', 'transform'].forEach((m) => { ctx[m] = noop(m); });
  ctx.setLineDash = function () { calls.count++; };
  ctx.getLineDash = function () { return []; };
  ctx.measureText = function (text) { return { width: String(text).length * 6, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2 }; };
  ctx.createLinearGradient = function () { calls.byName.gradient = (calls.byName.gradient || 0) + 1; return { addColorStop: function () {} }; };
  ctx.createRadialGradient = ctx.createLinearGradient;
  ctx.createPattern = function () { return null; };
  ctx.getImageData = function (x, y, w, h) { return { width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }; };
  ctx._calls = calls;
  return ctx;
}

/* ------------------------------------------------------------------ document */
export function createDocument(html, cssText) {
  const doc = {
    nodeType: 9,
    readyState: 'complete',
    activeElement: null,
    listeners: {},
    createElement(tag) { return new Element(doc, tag); },
    createElementNS(ns, tag) { return new Element(doc, tag); },
    createTextNode(text) { return new TextNode(doc, text); },
    createDocumentFragment() { return new Element(doc, '#fragment'); },
    getElementById(id) { return queryAll(doc.documentElement, '#' + id)[0] || null; },
    querySelector(sel) { return queryAll(doc.documentElement, sel)[0] || null; },
    querySelectorAll(sel) { return queryAll(doc.documentElement, sel); },
    addEventListener(type, fn) { (doc.listeners[type] = doc.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const l = doc.listeners[type]; if (!l) return;
      const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
    },
    dispatchEvent(ev) {
      const l = doc.listeners[ev.type];
      if (l) for (const fn of l.slice()) fn.call(doc, ev);
      return true;
    }
  };

  const parsed = parseFragment(html, doc);
  const htmlEl = parsed.children.find((c) => c.localName === 'html') || parsed;
  doc.documentElement = htmlEl;
  htmlEl.ownerDocument = doc;
  doc.body = queryAll(htmlEl, 'body')[0] || htmlEl;
  doc.head = queryAll(htmlEl, 'head')[0] || null;
  doc.activeElement = doc.body;

  /* CSS custom properties, read from the real stylesheet */
  const vars = {};
  if (cssText) {
    const rootBlock = /:root\s*\{([\s\S]*?)\}/.exec(cssText);
    if (rootBlock) {
      const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
      let m;
      while ((m = re.exec(rootBlock[1])) !== null) vars[m[1]] = m[2].trim();
    }
  }
  doc._cssVars = vars;
  return doc;
}

export function getComputedStyleShim(doc) {
  return function getComputedStyle() {
    return {
      getPropertyValue(name) { return doc._cssVars[name] || ''; }
    };
  };
}

export { Element, TextNode, Node, parseFragment, makeCanvas2D };
