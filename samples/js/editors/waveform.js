/* ==========================================================================
   SampleForge — js/editors/waveform.js
   Interactive single-cycle waveform editor.

   Drawing is two-way bound to the harmonic spectrum: every stroke is analysed
   with a DFT and written to the spectrum as manual overrides, so what you draw
   is exactly what the harmonic panel shows (and what you hear). The faint grey
   trace behind your drawing is what the rule stack alone would produce.
   ========================================================================== */
(function (root) {
  'use strict';

  var SG = (root.SG = root.SG || {});
  var U = SG.util;
  var H = SG.Harmonics;
  var Base = SG.EditorBase;
  var M = H.DFT_M;                 /* samples used while editing/analysing */
  var DISPLAY_M = 1024;            /* samples used to draw the curve */

  function WaveformEditor(canvas) {
    Base.call(this, canvas);
    this.pad = { l: 10, r: 10, t: 14, b: 18 };
    this.live = null;              /* Float32Array(M) while drawing */
    this.last = null;              /* previous pointer position */
    this.lineStart = null;         /* anchor for the line tool */
    this.linePreview = null;
    this.drawing = false;
    this.bindPointer();
  }
  WaveformEditor.prototype = Object.create(Base.prototype);
  WaveformEditor.prototype.constructor = WaveformEditor;
  SG.WaveformEditor = WaveformEditor;

  WaveformEditor.prototype.state = function () { return SG.Store.state; };

  WaveformEditor.prototype.freq = function () { return U.midiToFreq(this.state().note.midi); };

  WaveformEditor.prototype.spectrum = function () {
    var s = this.state();
    return H.computeSpectrum(s, this.freq(), s.sample.sampleRate);
  };

  /* The cycle currently shown: the live stroke if drawing, else the spectrum. */
  WaveformEditor.prototype.displayWave = function (sp, m) {
    m = m || DISPLAY_M;
    var wave = H.waveformFromSpectrum(sp.ampRaw, sp.phase, sp.N, m);
    var peak = 0;
    for (var i = 0; i < m; i++) { var a = Math.abs(wave[i]); if (a > peak) peak = a; }
    if (peak > 1) for (var j = 0; j < m; j++) wave[j] /= peak;
    return { wave: wave, peak: peak };
  };

  /* Rule-only spectrum (ignoring manual overrides) for the ghost trace. */
  WaveformEditor.prototype.ghostWave = function (sp, m) {
    var wave = H.waveformFromSpectrum(sp.base, sp.basePhase, sp.N, m || DISPLAY_M);
    var peak = 0;
    for (var i = 0; i < wave.length; i++) { var a = Math.abs(wave[i]); if (a > peak) peak = a; }
    if (peak > 1) for (var k = 0; k < wave.length; k++) wave[k] /= peak;
    return wave;
  };

  WaveformEditor.prototype.currentWave = function () {
    if (this.live) return Float32Array.from(this.live);
    return this.displayWave(this.spectrum(), M).wave;
  };

  /* ------------------------------------------------------------ persistence */
  /* A drawing covers the whole spectrum, so build the override lists directly
     (setOverride per harmonic would be quadratic while dragging). */
  WaveformEditor.prototype.writeOverrides = function (state, wave) {
    var N = state.harmonics.count;
    var res = H.spectrumFromWaveform(wave, N);
    var amp = [], ph = [];
    for (var n = 1; n <= N; n++) {
      amp.push({ n: n, v: Math.round(res.amp[n] * 100000) / 100000 });
      var turn = ((res.phase[n] % 1) + 1) % 1;
      ph.push({ n: n, v: Math.round(turn * 100000) / 100000 });
    }
    state.harmonics.overrides.amp = amp;
    state.harmonics.overrides.phase = ph;
    state.harmonics.drawn = true;
  };

  WaveformEditor.prototype.commitLive = function () {
    if (!this.live) return;
    var wave = Float32Array.from(this.live);
    SG.Store.updateTransient(function (s) { this.writeOverrides(s, wave); }.bind(this));
  };

  WaveformEditor.prototype.applyOp = function (op, label) {
    var self = this;
    var wave = op(this.currentWave());
    SG.Store.update(function (s) { self.writeOverrides(s, wave); });
    this.setStatus(label);
    this.requestDraw();
  };

  /* ------------------------------------------------------------- interaction */
  WaveformEditor.prototype.bindPointer = function () {
    var self = this;
    this.canvas.title = 'Drag to draw one cycle · shift snaps to the grid · double-click sets a constant · ' +
      'right-click clears the drawing';
    U.attachPointer(this.canvas, {
      down: function (x, y, ev) { self.onDown(x, y, ev); },
      drag: function (x, y, ev) { self.onDrag(x, y, ev); },
      up: function (x, y, ev) { self.onUp(x, y, ev); },
      hover: function (x, y, ev) { self.onHover(x, y, ev); },
      hoverEnd: function () { self.hover = null; self.requestDraw(); },
      dblclick: function (x, y, ev) { self.onDouble(x, y, ev); },
      context: function (x, y, ev) { self.onContext(x, y, ev); }
    });
  };

  WaveformEditor.prototype.tool = function () { return this.state().ui.waveTool || 'draw'; };

  WaveformEditor.prototype.valueAt = function (p, x, y, ev) {
    var v = this.yToValue(p, y, -1, 1);
    if (ev && ev.shiftKey) v = Math.round(v * 20) / 20;
    return U.clamp(v, -1, 1);
  };

  WaveformEditor.prototype.paintStroke = function (p, x0, y0, x1, y1, ev) {
    var mirror = !!this.state().ui.mirror;
    var erase = this.tool() === 'erase';
    var n0 = this.xToNorm(p, x0), n1 = this.xToNorm(p, x1);
    var m0 = Math.round(n0 * (M - 1)), m1 = Math.round(n1 * (M - 1));
    var lo = Math.min(m0, m1), hi = Math.max(m0, m1);
    var v0 = erase ? 0 : this.valueAt(p, x0, y0, ev);
    var v1 = erase ? 0 : this.valueAt(p, x1, y1, ev);
    for (var m = lo; m <= hi; m++) {
      var t = hi === lo ? 1 : (m - lo) / (hi - lo);
      var v = m0 <= m1 ? U.lerp(v0, v1, t) : U.lerp(v1, v0, t);
      this.live[m] = v;
      if (mirror) this.live[(M - m) % M] = -v;
    }
  };

  WaveformEditor.prototype.paintLine = function (p, a, b) {
    this.paintStroke(p, a.x, a.y, b.x, b.y, null);
  };

  WaveformEditor.prototype.onDown = function (x, y, ev) {
    var p = this.plot();
    var tool = this.tool();
    if (tool === 'line') {
      if (!this.lineStart) {
        this.beginGesture();
        this.live = this.currentWave();
        this.lineStart = { x: x, y: y };
        this.linePreview = { x: x, y: y };
        this.requestDraw();
      } else {
        this.paintLine(p, this.lineStart, { x: x, y: y });
        this.commitLive();
        this.lineStart = null;
        this.linePreview = null;
        this.live = null;
        this.endGesture();
        this.requestDraw();
      }
      return;
    }
    this.beginGesture();
    this.drawing = true;
    this.live = this.currentWave();
    this.last = { x: x, y: y };
    this.paintStroke(p, x, y, x, y, ev);
    this.commitLive();
    this.requestDraw();
  };

  WaveformEditor.prototype.onDrag = function (x, y, ev) {
    var p = this.plot();
    if (this.tool() === 'line') {
      if (this.lineStart) { this.linePreview = { x: x, y: y }; this.requestDraw(); }
      return;
    }
    if (!this.drawing || !this.live) return;
    this.paintStroke(p, this.last.x, this.last.y, x, y, ev);
    this.last = { x: x, y: y };
    this.commitLive();
    this.requestDraw();
  };

  WaveformEditor.prototype.onUp = function () {
    if (this.tool() === 'line') return;
    if (!this.drawing) return;
    this.drawing = false;
    this.last = null;
    this.commitLive();
    this.live = null;
    this.endGesture();
    this.requestDraw();
  };

  WaveformEditor.prototype.onHover = function (x, y) {
    var p = this.plot();
    this.hover = { x: x, y: y, n: this.xToNorm(p, x), v: this.yToValue(p, y, -1, 1) };
    this.requestDraw();
  };

  WaveformEditor.prototype.onDouble = function (x, y) {
    /* double-click a spot → set the whole cycle to that constant (handy for
       building pulse/step shapes), double-click the centre line → clear */
    var p = this.plot();
    var v = this.yToValue(p, y, -1, 1);
    if (Math.abs(v) < 0.02) { this.clearDraw(); return; }
    var self = this;
    var wave = new Float32Array(M).fill(U.clamp(v, -1, 1));
    SG.Store.update(function (s) { self.writeOverrides(s, wave); });
    this.setStatus('Cycle set to ' + U.fmt.num(v, 2));
    this.requestDraw();
  };

  WaveformEditor.prototype.onContext = function (x, y) { this.clearDraw(); };

  WaveformEditor.prototype.clearDraw = function () {
    SG.Store.update(function (s) {
      s.harmonics.overrides.amp = [];
      s.harmonics.overrides.phase = [];
      s.harmonics.drawn = false;
    });
    this.live = null; this.lineStart = null; this.linePreview = null;
    this.setStatus('Drawing cleared — back to the rule stack');
    this.requestDraw();
  };

  /* ------------------------------------------------------------------- draw */
  WaveformEditor.prototype.draw = function (ctx, w, h) {
    var t = this.t();
    var p = this.plot();
    var sp = this.spectrum();
    var st = this.state();

    /* grid */
    this.grid(ctx, p, { rows: 4, cols: 8, bipolar: true });
    ctx.save();
    ctx.strokeStyle = SG.rgba(t.text3, 0.35);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(p.x, Math.round(p.y + p.h / 2) + 0.5); ctx.lineTo(p.x + p.w, Math.round(p.y + p.h / 2) + 0.5);
    ctx.stroke();
    ctx.restore();

    var hasOverrides = H.overrideCount(st.harmonics.overrides.amp, sp.N) > 0;

    /* ghost: what the rules alone produce */
    if (hasOverrides) {
      var ghost = this.ghostWave(sp);
      this.strokePath(ctx, p, ghost, SG.rgba(t.text3, 0.4), 1, false);
    }

    /* main trace */
    var wave = this.live || this.displayWave(sp).wave;
    var m = wave.length;
    this.strokePath(ctx, p, wave, t.wave, 2, true);

    /* line-tool preview */
    if (this.lineStart && this.linePreview) {
      ctx.save();
      ctx.strokeStyle = SG.rgba(t.text, 0.75);
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(this.lineStart.x, this.lineStart.y);
      ctx.lineTo(this.linePreview.x, this.linePreview.y);
      ctx.stroke();
      ctx.restore();
    }

    /* hover crosshair */
    if (this.hover && !this.drawing) {
      var hx = U.clamp(this.hover.x, p.x, p.x + p.w);
      ctx.save();
      ctx.strokeStyle = SG.rgba(t.text3, 0.35);
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(hx + 0.5, p.y); ctx.lineTo(hx + 0.5, p.y + p.h); ctx.stroke();
      ctx.restore();
      var idx = Math.round(this.hover.n * (m - 1));
      var val = wave[U.clamp(idx, 0, m - 1)];
      this.label(ctx, U.fmt.num(val, 3), U.clamp(hx + 6, p.x, p.x + p.w - 42), p.y + 10, { color: SG.rgba(t.text2, 0.9) });
    }

    /* axis labels */
    this.label(ctx, '+1', p.x + 2, p.y + 9, { color: SG.rgba(t.text3, 0.8) });
    this.label(ctx, '0', p.x + 2, p.y + p.h / 2 - 3, { color: SG.rgba(t.text3, 0.8) });
    this.label(ctx, '-1', p.x + 2, p.y + p.h - 3, { color: SG.rgba(t.text3, 0.8) });
    for (var q = 0; q <= 4; q++) {
      var x = p.x + p.w * q / 4;
      this.label(ctx, q === 0 ? '0' : (q === 4 ? '1' : q + '/4'), x + (q === 0 ? 2 : (q === 4 ? -12 : -6)), p.y + p.h + 12,
        { color: SG.rgba(t.text3, 0.75), align: 'center' });
    }
    this.label(ctx, 'phase →', p.x + p.w - 46, p.y + p.h + 12, { color: SG.rgba(t.text3, 0.5) });

    /* info chip */
    var info = document.getElementById('wave-info');
    if (info) {
      var cyc = this.freq() > 0 ? 1 / this.freq() : 0;
      info.textContent = 'cycle ' + U.fmt.ms(cyc) + ' · ' + sp.N + ' harmonics · peak ' +
        U.fmt.num(sp.wavePeak, 2) + (st.harmonics.drawn ? ' · drawn' : '');
      info.className = 'chip chip--mono' + (st.harmonics.drawn ? ' chip--warn' : '');
    }
  };

  WaveformEditor.prototype.strokePath = function (ctx, p, wave, color, width, fill) {
    var m = wave.length;
    var mid = p.y + p.h / 2;
    var scale = p.h / 2 - 2;
    ctx.save();
    ctx.beginPath();
    for (var i = 0; i < m; i++) {
      var x = p.x + i / (m - 1) * p.w;
      var y = mid - wave[i] * scale;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    if (fill) {
      var grad = ctx.createLinearGradient(0, p.y, 0, p.y + p.h);
      grad.addColorStop(0, SG.rgba(color, 0.28));
      grad.addColorStop(0.5, SG.rgba(color, 0.07));
      grad.addColorStop(1, SG.rgba(color, 0.28));
      ctx.save();
      ctx.lineTo(p.x + p.w, mid); ctx.lineTo(p.x, mid); ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();
      ctx.restore();
      /* redraw the stroke path (fill consumed it) */
      ctx.beginPath();
      for (var j = 0; j < m; j++) {
        var xx = p.x + j / (m - 1) * p.w;
        var yy = mid - wave[j] * scale;
        if (j === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
      }
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = SG.rgba(color, 0.45);
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.restore();
  };

})(typeof window !== 'undefined' ? window : globalThis);
