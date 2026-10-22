/* ==========================================================================
   SampleForge — js/editors/envelope.js
   Breakpoint envelope editor, reused for amplitude, pitch and filter
   modulation. Points can be added (click), moved (drag), bent (drag the
   segment handle) and removed (double-click / right-click / Delete).
   ========================================================================== */
(function (root) {
  'use strict';

  var SG = (root.SG = root.SG || {});
  var U = SG.util;
  var E = SG.Envelope;
  var Base = SG.EditorBase;

  var MINOR_COLS = 40;
  var MAJOR_COLS = 10;
  var HIT = 9;          /* px radius for grabbing a point */
  var HIT_HANDLE = 8;

  function EnvelopeEditor(canvas) {
    Base.call(this, canvas);
    this.pad = { l: 40, r: 14, t: 14, b: 22 };
    this.selected = -1;
    this.dragMode = null;          /* 'point' | 'curve' */
    this.dragIndex = -1;
    this.hoverPoint = -1;
    this.hoverHandle = -1;
    canvas.tabIndex = 0;
    canvas.style.outline = 'none';
    canvas.title = 'Click to add a point · drag points · drag the square handle to bend a segment · ' +
      'double-click or right-click a point to delete · arrow keys nudge · shift bypasses snapping';
    this.bindPointer();
    this.bindKeys();
  }
  EnvelopeEditor.prototype = Object.create(Base.prototype);
  EnvelopeEditor.prototype.constructor = EnvelopeEditor;
  SG.EnvelopeEditor = EnvelopeEditor;

  EnvelopeEditor.prototype.key = function () { return SG.Store.state.ui.envTab || 'amp'; };

  /* bipolar destinations need more room for their axis labels */
  EnvelopeEditor.prototype.plot = function () {
    var cfg = this.cfg();
    this.pad.l = cfg && cfg.bipolar ? 50 : 40;
    return Base.prototype.plot.call(this);
  };
  EnvelopeEditor.prototype.cfg = function () { return SG.Store.ENV_CONFIG[this.key()]; };
  EnvelopeEditor.prototype.env = function () { return SG.Store.state.envelopes[this.key()]; };
  EnvelopeEditor.prototype.duration = function () { return SG.Store.state.sample.duration; };

  EnvelopeEditor.prototype.range = function () {
    var c = this.cfg();
    return { min: c.min, max: c.max };
  };

  /* --------------------------------------------------------------- geometry */
  EnvelopeEditor.prototype.pointXY = function (p, pt) {
    var r = this.range();
    return { x: this.normToX(p, pt.t), y: this.valueToY(p, pt.v, r.min, r.max) };
  };

  EnvelopeEditor.prototype.handleXY = function (p, env, i) {
    var a = env.points[i], b = env.points[i + 1];
    if (!b) return null;
    if (a.hold) return null;
    if (Math.abs(b.v - a.v) < 1e-6) return null;
    var tm = (a.t + b.t) / 2;
    var vm = E.segmentValue(a.v, b.v, a.c || 0, 0.5, false);
    var x1 = this.normToX(p, a.t), x2 = this.normToX(p, b.t);
    if (Math.abs(x2 - x1) < 18) return null;
    return { x: this.normToX(p, tm), y: this.valueToY(p, vm, this.range().min, this.range().max), i: i };
  };

  /* ------------------------------------------------------------ hit testing */
  EnvelopeEditor.prototype.hitTest = function (p, x, y) {
    var env = this.env();
    var i, xy, d;
    for (i = 0; i < env.points.length; i++) {
      xy = this.pointXY(p, env.points[i]);
      d = Math.hypot(xy.x - x, xy.y - y);
      if (d <= HIT) return { type: 'point', index: i, dist: d };
    }
    for (i = 0; i < env.points.length - 1; i++) {
      var h = this.handleXY(p, env, i);
      if (!h) continue;
      d = Math.hypot(h.x - x, h.y - y);
      if (d <= HIT_HANDLE) return { type: 'handle', index: i, dist: d };
    }
    return { type: 'empty', index: -1 };
  };

  /* ------------------------------------------------------------ interaction */
  EnvelopeEditor.prototype.bindPointer = function () {
    var self = this;
    U.attachPointer(this.canvas, {
      down: function (x, y, ev) { self.onDown(x, y, ev); },
      drag: function (x, y, ev) { self.onDrag(x, y, ev); },
      up: function (x, y, ev) { self.onUp(x, y, ev); },
      hover: function (x, y, ev) { self.onHover(x, y, ev); },
      hoverEnd: function () { self.hoverPoint = -1; self.hoverHandle = -1; self.canvas.style.cursor = 'crosshair'; self.requestDraw(); },
      dblclick: function (x, y, ev) { self.onDouble(x, y, ev); },
      context: function (x, y, ev) { self.onContext(x, y, ev); }
    });
  };

  EnvelopeEditor.prototype.snapT = function (t, ev) {
    var s = SG.Store.state;
    if (!s.ui.snap || (ev && ev.shiftKey)) return U.clamp(t, 0, 1);
    return U.clamp(Math.round(t * MINOR_COLS) / MINOR_COLS, 0, 1);
  };

  EnvelopeEditor.prototype.snapV = function (v, ev) {
    var s = SG.Store.state, r = this.range();
    if (!s.ui.snap || (ev && ev.shiftKey)) return U.clamp(v, r.min, r.max);
    var step = this.cfg().bipolar ? 0.05 : 0.05;
    return U.clamp(Math.round(v / step) * step, r.min, r.max);
  };

  EnvelopeEditor.prototype.onDown = function (x, y, ev) {
    var p = this.plot();
    var hit = this.hitTest(p, x, y);
    var self = this;
    this.beginGesture();

    if (hit.type === 'point') {
      this.dragMode = 'point';
      this.dragIndex = hit.index;
      this.selected = hit.index;
    } else if (hit.type === 'handle') {
      this.dragMode = 'curve';
      this.dragIndex = hit.index;
      this.selected = hit.index;
    } else {
      /* empty space → insert a new breakpoint and start dragging it */
      var t = this.snapT(this.xToNorm(p, x), ev);
      var v = this.snapV(this.yToValue(p, y, this.range().min, this.range().max), ev);
      var idx = -1;
      SG.Store.updateTransient(function (s) {
        idx = E.insertPoint(s.envelopes[self.key()], t, v);
      });
      this.dragMode = 'point';
      this.dragIndex = idx;
      this.selected = idx;
      this.setStatus('Point added at ' + U.fmt.ms(t * this.duration()));
    }
    if (SG.UI && SG.UI.syncEnvInspector) SG.UI.syncEnvInspector();
    this.requestDraw();
  };

  EnvelopeEditor.prototype.onDrag = function (x, y, ev) {
    if (!this.dragMode || this.dragIndex < 0) return;
    var p = this.plot(), self = this;
    var r = this.range();

    if (this.dragMode === 'point') {
      var t = this.snapT(this.xToNorm(p, x), ev);
      var v = this.snapV(this.yToValue(p, y, r.min, r.max), ev);
      var idx = this.dragIndex;
      SG.Store.updateTransient(function (s) {
        E.movePoint(s.envelopes[self.key()], idx, t, v, { min: r.min, max: r.max });
      });
    } else {
      var i = this.dragIndex;
      var target = this.yToValue(p, y, r.min, r.max);
      SG.Store.updateTransient(function (s) {
        var env = s.envelopes[self.key()];
        var a = env.points[i], b = env.points[i + 1];
        if (!a || !b) return;
        var lo = Math.min(a.v, b.v), hi = Math.max(a.v, b.v);
        a.c = U.clamp(E.solveCurvature(a.v, b.v, U.clamp(target, lo, hi)), -1, 1);
      });
    }
    if (SG.UI && SG.UI.syncEnvInspector) SG.UI.syncEnvInspector();
    this.requestDraw();
  };

  EnvelopeEditor.prototype.onUp = function () {
    if (!this.dragMode) { this.endGesture(); return; }
    this.dragMode = null;
    this.dragIndex = -1;
    this.endGesture();
    this.requestDraw();
  };

  EnvelopeEditor.prototype.onHover = function (x, y) {
    var p = this.plot();
    var hit = this.hitTest(p, x, y);
    this.hoverPoint = hit.type === 'point' ? hit.index : -1;
    this.hoverHandle = hit.type === 'handle' ? hit.index : -1;
    this.canvas.style.cursor = hit.type === 'empty' ? 'crosshair' : (hit.type === 'handle' ? 'ns-resize' : 'grab');
    this.requestDraw();
  };

  EnvelopeEditor.prototype.removePoint = function (index) {
    var self = this;
    var env = this.env();
    if (index < 0 || index >= env.points.length) return false;
    if (env.points.length <= E.MIN_POINTS) { this.setStatus('An envelope needs at least two points', 'warn'); return false; }
    if (index === 0 || index === env.points.length - 1) { this.setStatus('The first and last points are locked in time', 'warn'); return false; }
    SG.Store.update(function (s) { E.removePoint(s.envelopes[self.key()], index); });
    this.selected = -1;
    if (SG.UI && SG.UI.syncEnvInspector) SG.UI.syncEnvInspector();
    this.setStatus('Point removed');
    this.requestDraw();
    return true;
  };

  EnvelopeEditor.prototype.onDouble = function (x, y) {
    var p = this.plot();
    var hit = this.hitTest(p, x, y);
    if (hit.type === 'point') { this.removePoint(hit.index); return; }
    if (hit.type === 'handle') { this.toggleHold(hit.index); return; }
  };

  EnvelopeEditor.prototype.onContext = function (x, y) {
    var p = this.plot();
    var hit = this.hitTest(p, x, y);
    if (hit.type === 'point') this.removePoint(hit.index);
    else if (hit.type === 'handle') this.toggleHold(hit.index);
    else this.removePoint(this.selected);
  };

  EnvelopeEditor.prototype.toggleHold = function (index) {
    var self = this;
    SG.Store.update(function (s) {
      var pt = s.envelopes[self.key()].points[index];
      if (pt) pt.hold = !pt.hold;
    });
    this.requestDraw();
    if (SG.UI && SG.UI.syncEnvInspector) SG.UI.syncEnvInspector();
  };

  EnvelopeEditor.prototype.deleteSelected = function () {
    if (this.selected >= 0) return this.removePoint(this.selected);
    this.setStatus('No point selected', 'warn');
    return false;
  };

  EnvelopeEditor.prototype.select = function (i) { this.selected = i; this.requestDraw(); };

  /* ---------------------------------------------------------------- keyboard */
  EnvelopeEditor.prototype.bindKeys = function () {
    var self = this;
    this.canvas.addEventListener('keydown', function (ev) {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      var env = self.env();
      if (!env) return;
      var idx = self.selected;
      var handled = true;
      var r = self.range();

      if (idx >= 0 && idx < env.points.length) {
        var pt = env.points[idx];
        var stepT = ev.shiftKey ? 1 / MINOR_COLS : 1 / (MINOR_COLS * 4);
        var stepV = ev.shiftKey ? 0.05 : 0.01;
        switch (ev.key) {
          case 'ArrowLeft':
            SG.Store.update(function (s) { E.movePoint(s.envelopes[self.key()], idx, pt.t - stepT, pt.v, { min: r.min, max: r.max }); });
            break;
          case 'ArrowRight':
            SG.Store.update(function (s) { E.movePoint(s.envelopes[self.key()], idx, pt.t + stepT, pt.v, { min: r.min, max: r.max }); });
            break;
          case 'ArrowUp':
            SG.Store.update(function (s) { E.movePoint(s.envelopes[self.key()], idx, pt.t, pt.v + stepV, { min: r.min, max: r.max }); });
            break;
          case 'ArrowDown':
            SG.Store.update(function (s) { E.movePoint(s.envelopes[self.key()], idx, pt.t, pt.v - stepV, { min: r.min, max: r.max }); });
            break;
          case 'Delete':
          case 'Backspace':
            self.removePoint(idx);
            break;
          case 'h':
            self.toggleHold(idx);
            break;
          case 'Tab':
            self.select((idx + (ev.shiftKey ? -1 : 1) + env.points.length) % env.points.length);
            break;
          case 'Escape':
            self.selected = -1; self.requestDraw();
            break;
          default:
            handled = false;
        }
      } else if (ev.key === 'Escape') {
        handled = false;
      } else {
        handled = false;
      }
      if (handled) {
        ev.preventDefault();
        ev.stopPropagation();
        if (SG.UI && SG.UI.syncEnvInspector) SG.UI.syncEnvInspector();
      }
    });
  };

  /* ------------------------------------------------------------------- draw */
  EnvelopeEditor.prototype.draw = function (ctx, w, h) {
    var t = this.t();
    var cfg = this.cfg();
    var env = this.env();
    var st = SG.Store.state;
    var p = this.plot();
    var r = this.range();
    var dur = this.duration();
    var i, x, y;

    /* --- grid --- */
    ctx.save();
    ctx.lineWidth = 1;
    for (i = 0; i <= MINOR_COLS; i++) {
      x = Math.round(p.x + p.w * i / MINOR_COLS) + 0.5;
      var major = i % (MINOR_COLS / MAJOR_COLS) === 0;
      ctx.strokeStyle = SG.rgba(t.line, major ? 0.95 : 0.38);
      ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke();
    }
    for (i = 0; i <= 4; i++) {
      y = Math.round(p.y + p.h * i / 4) + 0.5;
      ctx.strokeStyle = SG.rgba(t.line, 0.8);
      ctx.beginPath(); ctx.moveTo(p.x, y); ctx.lineTo(p.x + p.w, y); ctx.stroke();
    }
    ctx.restore();

    /* zero / centre line for bipolar envelopes */
    if (cfg.bipolar) {
      var zy = Math.round(this.valueToY(p, 0, r.min, r.max)) + 0.5;
      ctx.save();
      ctx.strokeStyle = SG.rgba(t.text3, 0.55);
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(p.x, zy); ctx.lineTo(p.x + p.w, zy); ctx.stroke();
      ctx.restore();
    }

    /* --- value axis labels --- */
    for (i = 0; i <= 4; i++) {
      var val = r.max - (r.max - r.min) * i / 4;
      y = p.y + p.h * i / 4;
      var text = cfg.axis ? cfg.axis(val, st) : U.fmt.num(val, 2);
      this.label(ctx, text, p.x - 7, y + 3.5, { align: 'right', color: SG.rgba(t.text3, 0.9) });
    }

    /* --- time axis labels --- */
    var labelEvery = p.w > 560 ? 1 : 2;
    for (i = 0; i <= MAJOR_COLS; i++) {
      if (i % labelEvery !== 0 && i !== MAJOR_COLS) continue;
      x = p.x + p.w * i / MAJOR_COLS;
      this.label(ctx, U.fmt.ms(dur * i / MAJOR_COLS), x, p.y + p.h + 14,
        { align: i === 0 ? 'left' : (i === MAJOR_COLS ? 'right' : 'center'), color: SG.rgba(t.text3, 0.85) });
    }

    /* --- curve --- */
    var samples = Math.max(64, Math.min(1400, Math.round(p.w * 2)));
    var pts = new Float32Array(samples + 1);
    for (i = 0; i <= samples; i++) pts[i] = E.at(env, i / samples);

    var zeroY = this.valueToY(p, cfg.bipolar ? 0 : r.min, r.min, r.max);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(p.x, zeroY);
    for (i = 0; i <= samples; i++) ctx.lineTo(p.x + p.w * i / samples, this.valueToY(p, pts[i], r.min, r.max));
    ctx.lineTo(p.x + p.w, zeroY);
    ctx.closePath();
    var grad = ctx.createLinearGradient(0, p.y, 0, p.y + p.h);
    var col = cfg.key === 'amp' ? t.env : (cfg.key === 'pitch' ? t.voice : t.harm);
    grad.addColorStop(0, SG.rgba(col, 0.34));
    grad.addColorStop(1, SG.rgba(col, 0.05));
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    for (i = 0; i <= samples; i++) {
      x = p.x + p.w * i / samples;
      y = this.valueToY(p, pts[i], r.min, r.max);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.shadowColor = SG.rgba(col, 0.5);
    ctx.shadowBlur = 7;
    ctx.stroke();
    ctx.restore();

    /* --- curvature handles --- */
    for (i = 0; i < env.points.length - 1; i++) {
      var hnd = this.handleXY(p, env, i);
      if (!hnd) continue;
      var active = (this.dragMode === 'curve' && this.dragIndex === i) || this.hoverHandle === i;
      ctx.save();
      ctx.strokeStyle = SG.rgba(t.text3, active ? 0.85 : 0.45);
      ctx.setLineDash([2, 2]);
      var a = env.points[i], b = env.points[i + 1];
      var ax = this.pointXY(p, a), bx = this.pointXY(p, b);
      ctx.beginPath();
      ctx.moveTo((ax.x + bx.x) / 2, (ax.y + bx.y) / 2);
      ctx.lineTo(hnd.x, hnd.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = active ? t.text : SG.rgba(t.text2, 0.9);
      this.roundRect(ctx, hnd.x - 3.2, hnd.y - 3.2, 6.4, 6.4, 1.6);
      ctx.fill();
      ctx.restore();
    }

    /* --- hold markers --- */
    for (i = 0; i < env.points.length - 1; i++) {
      if (!env.points[i].hold) continue;
      var pa = this.pointXY(p, env.points[i]);
      var pb = this.pointXY(p, env.points[i + 1]);
      ctx.save();
      ctx.strokeStyle = SG.rgba(col, 0.5);
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      ctx.restore();
      this.label(ctx, 'hold', (pa.x + pb.x) / 2, pa.y - 6, { align: 'center', color: SG.rgba(t.text3, 0.9) });
    }

    /* --- points --- */
    for (i = 0; i < env.points.length; i++) {
      var xy = this.pointXY(p, env.points[i]);
      var locked = i === 0 || i === env.points.length - 1;
      var isSel = i === this.selected;
      var isHot = i === this.hoverPoint || (this.dragMode === 'point' && this.dragIndex === i);
      var rad = isSel || isHot ? 6 : 4.6;

      ctx.save();
      if (isSel) {
        ctx.beginPath(); ctx.arc(xy.x, xy.y, rad + 4.5, 0, U.TAU);
        ctx.fillStyle = SG.rgba(col, 0.18); ctx.fill();
      }
      ctx.beginPath(); ctx.arc(xy.x, xy.y, rad, 0, U.TAU);
      ctx.fillStyle = isSel ? col : (locked ? '#0b1017' : SG.rgba(col, 0.9));
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = isSel ? '#0b1017' : col;
      ctx.stroke();
      ctx.restore();

      if (isSel || isHot) {
        var pt = env.points[i];
        var txt = U.fmt.ms(pt.t * dur) + '  ' + (cfg.describe ? cfg.describe(pt.v, st) : U.fmt.num(pt.v, 3));
        var tx = U.clamp(xy.x + 10, p.x, p.x + p.w - 110);
        var ty = U.clamp(xy.y - 10, p.y + 11, p.y + p.h);
        ctx.save();
        ctx.font = t.font;
        var tw = ctx.measureText(txt).width + 10;
        ctx.fillStyle = SG.rgba('#0b1017', 0.85);
        this.roundRect(ctx, tx - 5, ty - 11, tw, 15, 4);
        ctx.fill();
        ctx.strokeStyle = SG.rgba(col, 0.5);
        ctx.stroke();
        ctx.fillStyle = t.text;
        ctx.textBaseline = 'middle';
        ctx.fillText(txt, tx, ty - 3);
        ctx.restore();
      }
    }

    /* --- playhead --- */
    var pos = SG.Audio.position();
    if (pos >= 0) {
      x = p.x + pos * p.w;
      var vy = this.valueToY(p, E.at(env, pos), r.min, r.max);
      ctx.save();
      ctx.strokeStyle = SG.rgba(t.text, 0.55);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + 0.5, p.y); ctx.lineTo(x + 0.5, p.y + p.h); ctx.stroke();
      ctx.fillStyle = t.text;
      ctx.beginPath(); ctx.arc(x, vy, 3, 0, U.TAU); ctx.fill();
      ctx.restore();
    }

    /* --- disabled overlay --- */
    if (!env.enabled) {
      ctx.save();
      ctx.fillStyle = 'rgba(8,11,17,0.62)';
      ctx.fillRect(p.x, p.y, p.w, p.h);
      ctx.fillStyle = SG.rgba(t.text2, 0.9);
      ctx.font = '12px ' + t.font.slice(4);
      ctx.textAlign = 'center';
      ctx.fillText(cfg.label + ' envelope is off', p.x + p.w / 2, p.y + p.h / 2);
      ctx.restore();
    }

    /* --- tag --- */
    var tag = document.getElementById('env-tag');
    if (tag) {
      var stats = E.stats(env);
      tag.textContent = cfg.label.toLowerCase() + ' · ' + stats.points + ' points · peak ' +
        (cfg.describe ? cfg.describe(stats.peak, st) : U.fmt.num(stats.peak, 2)) +
        ' @ ' + U.fmt.ms(stats.peakT * dur);
    }
  };

})(typeof window !== 'undefined' ? window : globalThis);
