/* ==========================================================================
   SampleForge — js/editors/base.js
   Shared plumbing for the canvas editors: DPR-correct sizing, resize
   handling, the plot rectangle, colours and small drawing helpers.
   ========================================================================== */
(function (root) {
  'use strict';

  var SG = (root.SG = root.SG || {});
  var U = SG.util;

  /* ------------------------------------------------------------------ theme */
  var themeCache = null;
  SG.Theme = {
    get: function () {
      if (themeCache) return themeCache;
      var cs = root.getComputedStyle ? getComputedStyle(document.documentElement) : null;
      function v(name, fallback) {
        if (!cs) return fallback;
        var val = cs.getPropertyValue(name);
        return val && val.trim() ? val.trim() : fallback;
      }
      themeCache = {
        bg: v('--bg', '#080b11'),
        panel: v('--panel', '#111823'),
        line: v('--line', '#1e2937'),
        lineSoft: v('--line-soft', '#172130'),
        text: v('--text', '#e8eef6'),
        text2: v('--text-2', '#a7b4c4'),
        text3: v('--text-3', '#6d7c8f'),
        wave: v('--wave', '#35d6c0'),
        harm: v('--harm', '#ffb454'),
        env: v('--env', '#a78bfa'),
        voice: v('--voice', '#60a5fa'),
        out: v('--out', '#f472b6'),
        accent: v('--accent', '#35d6c0'),
        danger: v('--danger', '#ff6b6b'),
        font: '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSm: '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
      };
      return themeCache;
    },
    reset: function () { themeCache = null; }
  };

  function rgba(hex, alpha) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (!isFinite(n)) return hex;
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  /* ------------------------------------------------------------- base class */
  function EditorBase(canvas, opts) {
    this.canvas = canvas;
    this.opts = opts || {};
    this.ctx = null;
    this.w = 300; this.h = 150;
    this.pad = { l: 10, r: 12, t: 12, b: 16 };
    this.hover = null;
    this._queued = false;
    this.enabled = true;
    this.installResize();
  }
  SG.EditorBase = EditorBase;

  EditorBase.prototype.installResize = function () {
    var self = this;
    if (root.ResizeObserver) {
      this._ro = new root.ResizeObserver(function () { self.requestDraw(); });
      this._ro.observe(this.canvas);
    } else {
      this._onResize = function () { self.requestDraw(); };
      root.addEventListener('resize', this._onResize);
    }
  };

  EditorBase.prototype.requestDraw = function () {
    var self = this;
    if (this._queued) return;
    this._queued = true;
    root.requestAnimationFrame(function () {
      self._queued = false;
      try { self.render(); } catch (err) { console.error('[SampleForge] draw error', err); }
    });
  };

  EditorBase.prototype.render = function () {
    var fit = U.fitCanvas(this.canvas);
    this.ctx = fit.ctx; this.w = fit.w; this.h = fit.h;
    var ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    this.draw(ctx, this.w, this.h);
  };

  /* Subclasses override this. */
  EditorBase.prototype.draw = function () {};

  EditorBase.prototype.plot = function (extra) {
    var p = {
      x: this.pad.l, y: this.pad.t,
      w: Math.max(10, this.w - this.pad.l - this.pad.r),
      h: Math.max(10, this.h - this.pad.t - this.pad.b)
    };
    if (extra) { for (var k in extra) p[k] = extra[k]; }
    return p;
  };

  EditorBase.prototype.t = function () { return SG.Theme.get(); };

  /* ------------------------------------------------------------ draw helpers */
  EditorBase.prototype.clearBg = function (ctx, w, h, color) {
    ctx.fillStyle = color || 'rgba(6,9,14,0)';
    ctx.fillRect(0, 0, w, h);
  };

  EditorBase.prototype.roundRect = function (ctx, x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  };

  EditorBase.prototype.grid = function (ctx, p, opts) {
    opts = opts || {};
    var t = this.t();
    ctx.save();
    ctx.lineWidth = 1;
    /* horizontal */
    var rows = opts.rows || 4;
    for (var i = 0; i <= rows; i++) {
      var y = Math.round(p.y + p.h * i / rows) + 0.5;
      var mid = opts.bipolar && i === rows / 2;
      ctx.strokeStyle = mid ? rgba(t.text3, 0.45) : rgba(t.line, 0.85);
      ctx.beginPath(); ctx.moveTo(p.x, y); ctx.lineTo(p.x + p.w, y); ctx.stroke();
    }
    /* vertical */
    var cols = opts.cols || 8;
    for (var j = 0; j <= cols; j++) {
      var x = Math.round(p.x + p.w * j / cols) + 0.5;
      ctx.strokeStyle = rgba(t.line, j === 0 || j === cols ? 0.9 : 0.55);
      ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke();
    }
    ctx.restore();
  };

  EditorBase.prototype.label = function (ctx, text, x, y, opts) {
    opts = opts || {};
    var t = this.t();
    ctx.save();
    ctx.font = opts.font || t.fontSm;
    ctx.fillStyle = opts.color || rgba(t.text3, 0.9);
    ctx.textAlign = opts.align || 'left';
    ctx.textBaseline = opts.baseline || 'alphabetic';
    ctx.fillText(text, x, y);
    ctx.restore();
  };

  /* Vertical position ↔ normalised value inside a plot rect. */
  EditorBase.prototype.yToValue = function (p, y, min, max) {
    var v = max - (y - p.y) / p.h * (max - min);
    return U.clamp(v, min, max);
  };
  EditorBase.prototype.valueToY = function (p, v, min, max) {
    return p.y + (max - U.clamp(v, min, max)) / (max - min) * p.h;
  };
  EditorBase.prototype.xToNorm = function (p, x) { return U.clamp((x - p.x) / p.w, 0, 1); };
  EditorBase.prototype.normToX = function (p, n) { return p.x + U.clamp(n, 0, 1) * p.w; };

  EditorBase.prototype.setStatus = function (msg, kind) {
    if (SG.UI && SG.UI.status) SG.UI.status(msg, kind);
  };

  EditorBase.prototype.beginGesture = function () { SG.Store.beginGesture(); };
  EditorBase.prototype.endGesture = function () { SG.Store.endGesture(); };

  SG.rgba = rgba;

})(typeof window !== 'undefined' ? window : globalThis);
