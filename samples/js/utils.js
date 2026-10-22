/* ==========================================================================
   SampleForge — js/utils.js
   Small dependency-free helpers shared by every module.
   Attaches to the global `SG` namespace (classic scripts, so the app also
   works when index.html is opened straight from disk).
   ========================================================================== */
(function (root) {
  'use strict';

  var SG = (root.SG = root.SG || {});
  var U = (SG.util = {});

  U.TAU = Math.PI * 2;

  /* ------------------------------------------------------------- numbers */
  U.clamp = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };
  U.lerp = function (a, b, t) { return a + (b - a) * t; };
  U.invLerp = function (a, b, v) { return b === a ? 0 : (v - a) / (b - a); };
  U.round = function (v, step) { return step > 0 ? Math.round(v / step) * step : v; };
  U.snapTo = function (v, step, lo, hi) { return U.clamp(Math.round(v / step) * step, lo, hi); };
  U.nearly = function (a, b, eps) { return Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps); };
  U.sum = function (arr) { var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i]; return s; };

  U.uid = function (prefix) {
    return (prefix || 'id') + '-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
  };

  /* ------------------------------------------------- deterministic noise */
  /* Integer hash → float in [0,1). Same (n, seed) always gives the same
     value, which keeps "random" spectra reproducible across renders. */
  U.hash01 = function (n, seed) {
    var x = (n | 0) ^ Math.imul((seed | 0) + 0x9e3779b1, 0x85ebca6b);
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  };
  U.hashSigned = function (n, seed) { return U.hash01(n, seed) * 2 - 1; };
  U.mulberry32 = function (seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /* --------------------------------------------------------------- music */
  U.NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  U.midiToFreq = function (m) { return 440 * Math.pow(2, (m - 69) / 12); };
  U.freqToMidi = function (f) { return 69 + 12 * Math.log2(f / 440); };
  U.noteName = function (m) {
    m = Math.round(m);
    return U.NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  };
  U.isBlackKey = function (m) { return [1, 3, 6, 8, 10].indexOf(((m % 12) + 12) % 12) >= 0; };

  /* ---------------------------------------------------------- formatting */
  U.fmt = {
    num: function (v, digits) {
      if (!isFinite(v)) return '—';
      var d = digits === undefined ? 2 : digits;
      return Number(v).toFixed(d);
    },
    hz: function (f) {
      if (!isFinite(f)) return '—';
      if (f >= 10000) return (f / 1000).toFixed(1) + ' kHz';
      if (f >= 1000) return (f / 1000).toFixed(2) + ' kHz';
      if (f >= 100) return f.toFixed(1) + ' Hz';
      return f.toFixed(2) + ' Hz';
    },
    ms: function (sec) {
      if (!isFinite(sec)) return '—';
      var ms = sec * 1000;
      if (ms < 1) return (ms * 1000).toFixed(0) + ' µs';
      if (ms < 10) return ms.toFixed(2) + ' ms';
      if (ms < 1000) return ms.toFixed(1) + ' ms';
      return (ms / 1000).toFixed(3) + ' s';
    },
    db: function (v) {
      if (!isFinite(v) || v <= 1e-7) return '-∞ dB';
      return (20 * Math.log10(v)).toFixed(1) + ' dB';
    },
    pct: function (v, digits) { return (v * 100).toFixed(digits === undefined ? 0 : digits) + '%'; },
    cents: function (c) { return (c > 0 ? '+' : '') + c.toFixed(0) + '¢'; },
    semis: function (s) { return (s > 0 ? '+' : '') + s.toFixed(2) + ' st'; },
    turnsToDeg: function (t) { return (((t % 1) + 1) % 1 * 360).toFixed(0) + '°'; }
  };

  /* ------------------------------------------------------------- objects */
  U.deepClone = function (o) { return JSON.parse(JSON.stringify(o)); };

  /* Recursive merge of a plain-JSON patch into target (patch wins).
     Arrays in the patch replace the target array. */
  U.mergeDeep = function (target, patch) {
    if (!patch || typeof patch !== 'object') return target;
    for (var k in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
      var pv = patch[k];
      var tv = target ? target[k] : undefined;
      if (pv && typeof pv === 'object' && !Array.isArray(pv)) {
        target[k] = U.mergeDeep(tv && typeof tv === 'object' && !Array.isArray(tv) ? tv : {}, pv);
      } else if (pv !== undefined) {
        target[k] = Array.isArray(pv) ? U.deepClone(pv) : pv;
      }
    }
    return target;
  };

  /* --------------------------------------------------------- async/timing */
  U.debounce = function (fn, wait) {
    var t = 0;
    var wrapped = function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, wait || 120);
    };
    wrapped.cancel = function () { clearTimeout(t); };
    return wrapped;
  };

  /* Coalesce calls into one per animation frame. */
  U.raf = function (fn) {
    var queued = false, lastArgs = null;
    return function () {
      lastArgs = arguments;
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; fn.apply(null, lastArgs); });
    };
  };

  /* ------------------------------------------------------------ canvas I/O */
  /* Resize the backing store for the current DPR and return a 2D context
     already scaled so drawing code can work in CSS pixels. */
  U.fitCanvas = function (canvas) {
    var dpr = Math.max(1, Math.min(3, root.devicePixelRatio || 1));
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width || canvas.clientWidth || 300));
    var h = Math.max(1, Math.round(rect.height || canvas.clientHeight || 150));
    var bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h, dpr: dpr };
  };

  U.pointerPos = function (canvas, ev) {
    var r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };

  /* Unified pointer handling for the editors: down / drag / hover / up /
     double-click / context menu / wheel, with pointer capture and touch. */
  U.attachPointer = function (canvas, h) {
    var dragging = false;
    h = h || {};

    canvas.addEventListener('pointerdown', function (ev) {
      if (ev.button === 2) return;                 /* context menu handles it */
      var p = U.pointerPos(canvas, ev);
      dragging = true;
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      canvas.focus && canvas.focus();
      if (h.down) h.down(p.x, p.y, ev);
      ev.preventDefault();
    });

    canvas.addEventListener('pointermove', function (ev) {
      var p = U.pointerPos(canvas, ev);
      if (dragging) { if (h.drag) h.drag(p.x, p.y, ev); }
      else if (h.hover) h.hover(p.x, p.y, ev);
    });

    function end(ev) {
      if (!dragging) return;
      dragging = false;
      var p = U.pointerPos(canvas, ev);
      if (h.up) h.up(p.x, p.y, ev);
    }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    canvas.addEventListener('pointerleave', function (ev) {
      if (!dragging && h.hoverEnd) h.hoverEnd(ev);
    });

    if (h.dblclick) canvas.addEventListener('dblclick', function (ev) {
      var p = U.pointerPos(canvas, ev); h.dblclick(p.x, p.y, ev); ev.preventDefault();
    });

    canvas.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      if (h.context) { var p = U.pointerPos(canvas, ev); h.context(p.x, p.y, ev); }
    });

    if (h.wheel) canvas.addEventListener('wheel', function (ev) {
      var p = U.pointerPos(canvas, ev);
      if (h.wheel(ev.deltaY, p.x, p.y, ev) !== false) ev.preventDefault();
    }, { passive: false });
  };

  /* ------------------------------------------------------------- download */
  U.downloadBlob = function (blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  };

  U.escapeHtml = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  U.$ = function (sel, scope) { return (scope || document).querySelector(sel); };
  U.$$ = function (sel, scope) { return Array.prototype.slice.call((scope || document).querySelectorAll(sel)); };

  U.el = function (tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  };

})(typeof window !== 'undefined' ? window : globalThis);
