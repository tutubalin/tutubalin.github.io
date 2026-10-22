/* ==========================================================================
   SampleForge — js/editors/harmonic.js
   Harmonic spectrum editor: amplitude bars + an optional phase lane.
   Dragging writes absolute overrides (drawn in cyan) on top of the rule stack
   (drawn in amber); alt/right-click hands a harmonic back to the rules.
   ========================================================================== */
(function (root) {
  'use strict';

  var SG = (root.SG = root.SG || {});
  var U = SG.util;
  var H = SG.Harmonics;
  var Base = SG.EditorBase;

  function HarmonicEditor(canvas) {
    Base.call(this, canvas);
    this.pad = { l: 30, r: 10, t: 12, b: 20 };
    this.phaseH = 0;
    this.sel = -1;
    this.hoverN = -1;
    this.dragMode = null;          /* 'amp' | 'phase' */
    this.lastX = 0;
    this.bindPointer();
  }
  HarmonicEditor.prototype = Object.create(Base.prototype);
  HarmonicEditor.prototype.constructor = HarmonicEditor;
  SG.HarmonicEditor = HarmonicEditor;

  HarmonicEditor.prototype.state = function () { return SG.Store.state; };

  HarmonicEditor.prototype.spectrum = function () {
    var s = this.state();
    return H.computeSpectrum(s, U.midiToFreq(s.note.midi), s.sample.sampleRate);
  };

  HarmonicEditor.prototype.geometry = function () {
    var st = this.state();
    var showPhase = !!st.ui.showPhase;
    var p = this.plot();
    var laneH = showPhase ? Math.max(30, Math.round(p.h * 0.24)) : 0;
    var gap = showPhase ? 10 : 0;
    return {
      showPhase: showPhase,
      amp: { x: p.x, y: p.y, w: p.w, h: p.h - laneH - gap },
      phase: { x: p.x, y: p.y + p.h - laneH, w: p.w, h: laneH },
      all: p
    };
  };

  HarmonicEditor.prototype.barRect = function (g, n, N) {
    var slot = g.amp.w / N;
    var bw = Math.max(1.5, Math.min(slot * 0.72, 26));
    var cx = g.amp.x + slot * (n - 0.5);
    return { x: cx - bw / 2, w: bw, cx: cx, slot: slot };
  };

  HarmonicEditor.prototype.nAt = function (g, x, N) {
    var slot = g.amp.w / N;
    return U.clamp(Math.floor((x - g.amp.x) / slot) + 1, 1, N);
  };

  /* ------------------------------------------------------------- interaction */
  HarmonicEditor.prototype.bindPointer = function () {
    var self = this;
    this.canvas.title = 'Drag bars to set an amplitude · drag the phase lane to rotate a harmonic · ' +
      'alt-click (or right-click) hands a harmonic back to the rules · ctrl+scroll changes the count';
    U.attachPointer(this.canvas, {
      down: function (x, y, ev) { self.onDown(x, y, ev); },
      drag: function (x, y, ev) { self.onDrag(x, y, ev); },
      up: function () { self.onUp(); },
      hover: function (x, y, ev) { self.onHover(x, y, ev); },
      hoverEnd: function () { self.hoverN = -1; self.requestDraw(); },
      dblclick: function (x, y, ev) { self.onDouble(x, y, ev); },
      context: function (x, y, ev) { self.onContext(x, y, ev); },
      wheel: function (dy, x, y, ev) { return self.onWheel(dy, ev); }
    });
  };

  HarmonicEditor.prototype.onDown = function (x, y, ev) {
    var g = this.geometry();
    this.lastX = x;
    this.dragMode = (g.showPhase && y >= g.phase.y - 4) ? 'phase' : 'amp';
    if (ev.altKey) {                       /* alt-click = hand back to the rules */
      var mode = this.dragMode;
      this.dragMode = null;
      this.clearAt(x, mode);
      return;
    }
    this.beginGesture();
    this.paint(x, y, ev, this.dragMode);
  };

  HarmonicEditor.prototype.onDrag = function (x, y, ev) {
    if (!this.dragMode) return;
    /* paint every bar between the previous and current x so fast drags don't skip */
    var g = this.geometry(), sp = this.spectrum(), N = sp.N;
    var a = this.nAt(g, Math.min(this.lastX, x), N);
    var b = this.nAt(g, Math.max(this.lastX, x), N);
    for (var n = a; n <= b; n++) this.setBar(n, x, y, ev, this.dragMode);
    this.lastX = x;
    this.paint(x, y, ev, this.dragMode);
  };

  HarmonicEditor.prototype.onUp = function () {
    if (!this.dragMode) return;
    this.dragMode = null;
    this.endGesture();
    this.requestDraw();
  };

  HarmonicEditor.prototype.paint = function (x, y, ev, mode) {
    var g = this.geometry(), sp = this.spectrum(), N = sp.N;
    var n = this.nAt(g, x, N);
    this.setBar(n, x, y, ev, mode);
    this.sel = n;
  };

  HarmonicEditor.prototype.setBar = function (n, x, y, ev, mode) {
    var g = this.geometry();
    if (mode === 'phase') {
      if (!g.showPhase) return;
      /* the lane shows -180°..+180°; store it as turns in 0..1 */
      var wrapped = this.yToValue(g.phase, y, -0.5, 0.5);
      if (ev && ev.shiftKey) wrapped = Math.round(wrapped * 24) / 24;
      var turns = wrapped < 0 ? wrapped + 1 : wrapped;
      this.setOverride(n, 'phase', Math.round(turns * 10000) / 10000);
    } else {
      var v = this.yToValue(g.amp, y, 0, 1);
      if (ev && ev.shiftKey) v = Math.round(v * 20) / 20;
      v = U.clamp(v, 0, 1);
      this.setOverride(n, 'amp', Math.round(v * 10000) / 10000);
    }
  };

  HarmonicEditor.prototype.setOverride = function (n, kind, value) {
    SG.Store.updateTransient(function (s) {
      var list = kind === 'phase' ? s.harmonics.overrides.phase : s.harmonics.overrides.amp;
      list = H.setOverride(list, n, value);
      if (kind === 'phase') s.harmonics.overrides.phase = list; else s.harmonics.overrides.amp = list;
    });
    this.requestDraw();
  };

  HarmonicEditor.prototype.clearAt = function (x, mode) {
    var self = this;
    var g = this.geometry(), sp = this.spectrum(), N = sp.N;
    var n = this.nAt(g, x, N);
    SG.Store.update(function (s) {
      if (mode === 'phase' || !mode) s.harmonics.overrides.phase = H.clearOverride(s.harmonics.overrides.phase, n);
      if (mode !== 'phase') s.harmonics.overrides.amp = H.clearOverride(s.harmonics.overrides.amp, n);
    });
    this.setStatus('Harmonic ' + n + ' returned to the rules');
    this.requestDraw();
  };

  HarmonicEditor.prototype.onDouble = function (x, y, ev) { this.clearAt(x, null); };

  HarmonicEditor.prototype.onContext = function (x, y, ev) {
    var g = this.geometry();
    var mode = (g.showPhase && y >= g.phase.y - 4) ? 'phase' : 'amp';
    this.clearAt(x, mode);
  };

  /* Ctrl/⌘ + wheel zooms the harmonic count; a plain wheel scrolls the page,
     so the canvas never becomes a scroll trap. */
  HarmonicEditor.prototype.onWheel = function (dy, ev) {
    if (!ev || !(ev.ctrlKey || ev.metaKey)) return true;
    var st = this.state();
    var step = ev.shiftKey ? 8 : 1;
    var next = U.clamp(st.harmonics.count - Math.sign(dy) * step, 2, 128);
    if (next === st.harmonics.count) return false;
    SG.Store.update(function (s) { s.harmonics.count = next; });
    if (SG.UI && SG.UI.syncControls) SG.UI.syncControls();
    this.requestDraw();
    return false;
  };

  HarmonicEditor.prototype.onHover = function (x, y) {
    var g = this.geometry(), sp = this.spectrum();
    this.hoverN = this.nAt(g, x, sp.N);
    var info = document.getElementById('harm-info');
    if (info) {
      var n = this.hoverN;
      var ov = H.getOverride(this.state().harmonics.overrides.amp, n) !== null;
      info.textContent = 'n=' + n + ' · ' + U.fmt.hz(n * sp.freq) + ' · amp ' + U.fmt.num(sp.ampRaw[n], 3) +
        ' · phase ' + U.fmt.turnsToDeg(sp.phase[n]) + (ov ? ' · manual' : '') + (sp.muted[n] ? ' · above Nyquist' : '');
    }
    this.requestDraw();
  };

  /* ------------------------------------------------------------------- draw */
  HarmonicEditor.prototype.draw = function (ctx, w, h) {
    var t = this.t();
    var st = this.state();
    var sp = this.spectrum();
    var N = sp.N;
    var g = this.geometry();
    var i, n, r;

    /* --- amplitude grid --- */
    ctx.save();
    ctx.lineWidth = 1;
    for (i = 0; i <= 4; i++) {
      var y = Math.round(g.amp.y + g.amp.h * i / 4) + 0.5;
      ctx.strokeStyle = SG.rgba(t.line, i === 4 ? 1 : 0.7);
      ctx.beginPath(); ctx.moveTo(g.amp.x, y); ctx.lineTo(g.amp.x + g.amp.w, y); ctx.stroke();
      this.label(ctx, (1 - i / 4).toFixed(2), g.amp.x - 6, y + 3.5, { align: 'right', color: SG.rgba(t.text3, 0.85) });
    }
    ctx.restore();

    /* --- bars --- */
    for (n = 1; n <= N; n++) {
      r = this.barRect(g, n, N);
      var a = sp.ampRaw[n];
      var isOv = !!sp.overridden[n];
      var muted = !!sp.muted[n] && st.harmonics.antiAlias;
      var bh = Math.max(a > 0.0015 ? 1.5 : 0, a * g.amp.h);
      var color = isOv ? t.wave : t.harm;
      if (muted) color = SG.rgba(t.text3, 0.55);

      if (bh > 0) {
        var grad = ctx.createLinearGradient(0, g.amp.y + g.amp.h - bh, 0, g.amp.y + g.amp.h);
        grad.addColorStop(0, SG.rgba(color, muted ? 0.5 : 1));
        grad.addColorStop(1, SG.rgba(color, muted ? 0.16 : 0.42));
        ctx.fillStyle = grad;
        this.roundRect(ctx, r.x, g.amp.y + g.amp.h - bh, r.w, bh, Math.min(2.5, r.w / 3));
        ctx.fill();
      } else {
        /* a zeroed harmonic still gets a tick so the slot is visible */
        ctx.fillStyle = SG.rgba(t.text3, muted ? 0.18 : 0.3);
        ctx.fillRect(r.x, g.amp.y + g.amp.h - 1.5, r.w, 1.5);
      }

      if (isOv && !muted) {
        ctx.fillStyle = SG.rgba(t.wave, 0.95);
        ctx.beginPath();
        ctx.arc(r.cx, g.amp.y + g.amp.h - bh - 3.5, 1.7, 0, U.TAU);
        ctx.fill();
      }

      if (n === this.hoverN || n === this.sel) {
        ctx.fillStyle = SG.rgba(t.text, n === this.sel ? 0.10 : 0.06);
        ctx.fillRect(r.cx - r.slot / 2, g.amp.y, r.slot, g.amp.h);
      }
    }

    /* --- Nyquist marker --- */
    if (st.harmonics.antiAlias && sp.nyquistN < N && sp.nyquistN >= 0) {
      var nx = g.amp.x + g.amp.w * (sp.nyquistN + 0.5) / N;
      ctx.save();
      ctx.strokeStyle = SG.rgba(t.danger, 0.6);
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(nx + 0.5, g.amp.y); ctx.lineTo(nx + 0.5, g.amp.y + g.amp.h); ctx.stroke();
      ctx.restore();
      this.label(ctx, 'Nyquist', nx + 4, g.amp.y + 9, { color: SG.rgba(t.danger, 0.85) });
    }

    /* --- index labels --- */
    var every = N > 40 ? 8 : (N > 20 ? 4 : (N > 10 ? 2 : 1));
    for (n = 1; n <= N; n++) {
      if (n % every !== 0 && n !== 1) continue;
      r = this.barRect(g, n, N);
      this.label(ctx, String(n), r.cx, g.amp.y + g.amp.h + 12, { align: 'center', color: SG.rgba(t.text3, 0.8) });
    }
    if (sp.freq > 0) {
      this.label(ctx, U.fmt.hz(sp.freq) + ' fundamental', g.amp.x + 2, g.amp.y + g.amp.h + 12,
        { color: SG.rgba(t.text3, 0.55) });
    }

    /* --- phase lane --- */
    if (g.showPhase) {
      var lp = g.phase;
      ctx.save();
      ctx.fillStyle = SG.rgba(t.panel, 0.55);
      ctx.fillRect(lp.x, lp.y, lp.w, lp.h);
      ctx.strokeStyle = SG.rgba(t.line, 0.9);
      ctx.strokeRect(lp.x + 0.5, lp.y + 0.5, lp.w - 1, lp.h - 1);
      var mid = lp.y + lp.h / 2;
      ctx.strokeStyle = SG.rgba(t.text3, 0.35);
      ctx.beginPath(); ctx.moveTo(lp.x, Math.round(mid) + 0.5); ctx.lineTo(lp.x + lp.w, Math.round(mid) + 0.5); ctx.stroke();
      ctx.restore();
      this.label(ctx, 'phase', lp.x - 6, mid + 3.5, { align: 'right', color: SG.rgba(t.text3, 0.85) });
      this.label(ctx, '+180°', lp.x - 6, lp.y + 8, { align: 'right', color: SG.rgba(t.text3, 0.5), font: t.fontSm });
      this.label(ctx, '-180°', lp.x - 6, lp.y + lp.h - 2, { align: 'right', color: SG.rgba(t.text3, 0.5), font: t.fontSm });

      for (n = 1; n <= N; n++) {
        r = this.barRect(g, n, N);
        var turns = ((sp.phase[n] % 1) + 1) % 1;
        var wrapped = turns > 0.5 ? turns - 1 : turns;          /* -0.5..0.5 */
        var py = mid - wrapped * lp.h * 0.9;
        var pov = !!sp.phaseOverridden[n];
        ctx.strokeStyle = SG.rgba(pov ? t.wave : t.voice, sp.muted[n] && st.harmonics.antiAlias ? 0.3 : 0.85);
        ctx.lineWidth = Math.max(1.2, Math.min(r.w * 0.6, 6));
        ctx.beginPath(); ctx.moveTo(r.cx, mid); ctx.lineTo(r.cx, py); ctx.stroke();
        ctx.fillStyle = SG.rgba(pov ? t.wave : t.voice, sp.muted[n] && st.harmonics.antiAlias ? 0.35 : 1);
        ctx.beginPath(); ctx.arc(r.cx, py, Math.max(1.4, Math.min(r.w * 0.32, 3.2)), 0, U.TAU); ctx.fill();
      }
    }

    /* --- header chip --- */
    var info = document.getElementById('harm-info');
    if (info && this.hoverN < 0) {
      var ovc = H.overrideCount(st.harmonics.overrides.amp, N);
      info.textContent = N + ' harmonics · ' + sp.activeCount + ' active · peak ' + U.fmt.num(sp.wavePeak, 2) +
        (ovc ? ' · ' + ovc + ' manual' : '') + (sp.errors.length ? ' · rule error!' : '');
      info.className = 'chip chip--mono' + (sp.errors.length ? ' chip--err' : (ovc ? ' chip--warn' : ''));
    }
  };

})(typeof window !== 'undefined' ? window : globalThis);
