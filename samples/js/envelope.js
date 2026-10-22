/* ==========================================================================
   SampleForge — js/envelope.js
   Breakpoint envelope model: an ordered list of points (t, v, curvature)
   plus per-segment "hold" flags. Everything here is pure math so it can be
   used for offline curve sampling, on-screen drawing and unit tests alike.

   Point shape:  { t: 0..1, v: number, c: -1..1, hold: bool }
     t    normalised time across the whole sample (0 = start, 1 = end)
     v    normalised value (0..1 for amplitude, -1..1 for mod envelopes)
     c    curvature of the segment that STARTS at this point
     hold keep the value until the next point, then step
   ========================================================================== */
(function (root) {
  'use strict';

  var SG = (root.SG = root.SG || {});
  var U = SG.util;
  var E = (SG.Envelope = {});

  /* Curvature is stored in [-1, 1] and mapped to the exponent k of a
     normalised exponential ramp:  v(x) = v0 + (v1-v0) * (e^(kx)-1)/(e^k-1)
     k = 0 is a straight line, k > 0 bows towards v0, k < 0 bows towards v1. */
  var K_SCALE = 8;

  E.K_SCALE = K_SCALE;
  E.MIN_POINTS = 2;

  E.segmentValue = function (v0, v1, c, x, hold) {
    if (hold) return x >= 1 ? v1 : v0;
    if (v0 === v1) return v0;
    if (x <= 0) return v0;
    if (x >= 1) return v1;
    var k = (c || 0) * K_SCALE;
    if (Math.abs(k) < 1e-4) return v0 + (v1 - v0) * x;
    var num = Math.expm1(k * x);
    var den = Math.expm1(k);
    if (!isFinite(num) || !isFinite(den) || den === 0) return v0 + (v1 - v0) * x;
    return v0 + (v1 - v0) * (num / den);
  };

  /* Inverse of segmentValue at x = 0.5 — used so the curvature handle can be
     dragged to an arbitrary height and we solve for the matching curvature. */
  E.solveCurvature = function (v0, v1, target) {
    if (Math.abs(v1 - v0) < 1e-9) return 0;
    var lo = -1, hi = 1;
    var f = function (c) { return E.segmentValue(v0, v1, c, 0.5, false) - target; };
    var flo = f(lo), fhi = f(hi);
    if (flo * fhi > 0) return Math.abs(flo) < Math.abs(fhi) ? lo : hi;   /* out of reach */
    for (var i = 0; i < 42; i++) {
      var mid = (lo + hi) * 0.5, fm = f(mid);
      if (Math.abs(fm) < 1e-7) return mid;
      if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    }
    return (lo + hi) * 0.5;
  };

  E.segmentIndexAt = function (env, t) {
    var pts = env.points, n = pts.length;
    if (n < 2) return 0;
    if (t <= pts[0].t) return 0;
    if (t >= pts[n - 1].t) return n - 2;
    for (var i = 0; i < n - 1; i++) {
      if (t >= pts[i].t && t < pts[i + 1].t) return i;
    }
    return n - 2;
  };

  /* Evaluate the envelope at normalised time t. */
  E.at = function (env, t) {
    var pts = env.points;
    if (!pts || pts.length === 0) return 0;
    if (pts.length === 1) return pts[0].v;
    var i = E.segmentIndexAt(env, t);
    var a = pts[i], b = pts[i + 1];
    var span = b.t - a.t;
    var x = span <= 1e-12 ? 1 : (t - a.t) / span;
    return E.segmentValue(a.v, b.v, a.c || 0, x, !!a.hold);
  };

  /* Sample the curve into a Float32Array — exactly what gets handed to
     AudioParam.setValueCurveAtTime(), so preview and export always match. */
  E.sampleCurve = function (env, length) {
    var n = Math.max(2, Math.floor(length));
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) out[i] = E.at(env, i / (n - 1));
    return out;
  };

  E.sampleCurveMapped = function (env, length, mapFn) {
    var n = Math.max(2, Math.floor(length));
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) out[i] = mapFn(E.at(env, i / (n - 1)), i / (n - 1));
    return out;
  };

  /* Curve length for setValueCurveAtTime: fine enough for millisecond attacks,
     capped so long samples stay cheap. */
  E.curveLength = function (durationSec) {
    return U.clamp(Math.round(durationSec * 4000), 8, 65536);
  };

  /* ---------------------------------------------------------- editing ops */
  E.sortPoints = function (env) {
    env.points.sort(function (a, b) { return a.t - b.t; });
    return env;
  };

  E.insertPoint = function (env, t, v) {
    var pts = env.points;
    /* First/last points own the ends of the timeline. */
    t = U.clamp(t, pts[0].t, pts[pts.length - 1].t);
    var idx = pts.length - 1;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].t > t + 1e-9) { idx = i; break; }
    }
    var point = { t: t, v: v, c: 0, hold: false };
    /* inherit the curvature of the segment we are splitting */
    if (idx > 0 && pts[idx - 1]) point.c = pts[idx - 1].c || 0;
    pts.splice(idx, 0, point);
    return idx;
  };

  E.removePoint = function (env, index) {
    if (env.points.length <= E.MIN_POINTS) return -1;
    if (index <= 0 || index >= env.points.length - 1) return -1;   /* ends are locked */
    env.points.splice(index, 1);
    return index;
  };

  E.movePoint = function (env, index, t, v, opts) {
    opts = opts || {};
    var pts = env.points;
    var p = pts[index];
    if (!p) return;
    var lo = index === 0 ? 0 : pts[index - 1].t + (opts.minGap === undefined ? 0.002 : opts.minGap);
    var hi = index === pts.length - 1 ? 1 : pts[index + 1].t - (opts.minGap === undefined ? 0.002 : opts.minGap);
    p.t = index === 0 ? 0 : (index === pts.length - 1 ? 1 : U.clamp(t, lo, hi));
    p.v = U.clamp(v, opts.min === undefined ? 0 : opts.min, opts.max === undefined ? 1 : opts.max);
    if (lo > hi) p.t = pts[index].t;                                 /* degenerate: don't move */
  };

  E.stats = function (env) {
    var pts = env.points;
    var peak = 0, min = Infinity, max = -Infinity, sum = 0;
    var N = 512;
    for (var i = 0; i <= N; i++) {
      var v = E.at(env, i / N);
      sum += v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    /* time of the highest point (useful read-out for amplitude envelopes) */
    var peakT = 0, best = -Infinity;
    for (var j = 0; j <= N; j++) {
      var vv = Math.abs(E.at(env, j / N));
      if (vv > best) { best = vv; peakT = j / N; }
    }
    return { peak: peak, min: min === Infinity ? 0 : min, max: max === -Infinity ? 0 : max, mean: sum / (N + 1), peakT: peakT, points: pts.length };
  };

  /* ---------------------------------------------------------------- shapes */
  E.make = function (points) {
    return { points: points.map(function (p) { return { t: p[0], v: p[1], c: p.length > 2 ? p[2] : 0, hold: !!p[3] }; }) };
  };

  E.SHAPES = {
    flat:     { label: 'Flat',   pts: [[0, 1], [1, 1]] },
    gate:     { label: 'Gate',   pts: [[0, 0], [0.004, 1, 0, true], [0.985, 1, 0, true], [1, 0]] },
    pluck:    { label: 'Pluck',  pts: [[0, 0], [0.008, 1, 0.5], [0.35, 0.25, -0.55], [1, 0, -0.7]] },
    perc:     { label: 'Perc',   pts: [[0, 0], [0.003, 1, 0.7], [0.12, 0, -0.8], [1, 0]] },
    adsr:     { label: 'ADSR',   pts: [[0, 0], [0.06, 1, 0.45], [0.3, 0.62, -0.45], [0.62, 0.62, 0], [1, 0, -0.5]] },
    pad:      { label: 'Pad',    pts: [[0, 0], [0.3, 1, -0.55], [0.72, 0.85, 0.2], [1, 0, -0.4]] },
    swell:    { label: 'Swell',  pts: [[0, 0], [0.85, 1, -0.7], [1, 0.05, 0.6]] },
    tremolo:  { label: 'Tremolo', pts: [[0, 0.5], [0.125, 1, -0.4], [0.25, 0.5, 0.4], [0.375, 1, -0.4], [0.5, 0.5, 0.4], [0.625, 1, -0.4], [0.75, 0.5, 0.4], [0.875, 1, -0.4], [1, 0.5]] },
    stairs:   { label: 'Stairs', pts: [[0, 1, 0, true], [0.25, 0.75, 0, true], [0.5, 0.5, 0, true], [0.75, 0.25, 0, true], [1, 0]] },
    dip:      { label: 'Dip',    pts: [[0, 1], [0.4, 0.1, -0.5], [1, 1, -0.5]] }
  };

  E.applyShape = function (env, key) {
    var shape = E.SHAPES[key];
    if (!shape) return env;
    env.points = E.make(shape.pts).points;
    return env;
  };

  /* Bipolar versions of the same shapes for pitch/filter modulation. */
  E.MOD_SHAPES = {
    flat:    { label: 'Off',    pts: [[0, 0], [1, 0]] },
    up:      { label: 'Rise',   pts: [[0, -1, -0.4], [1, 1]] },
    down:    { label: 'Fall',   pts: [[0, 1], [1, -1, -0.4]] },
    scoop:   { label: 'Scoop',  pts: [[0, -0.6, 0.5], [0.25, 0, -0.3], [1, 0]] },
    drop:    { label: 'Drop',   pts: [[0, 1], [0.08, 0.9, 0.6], [1, -0.4, -0.5]] },
    bump:    { label: 'Bump',   pts: [[0, 0], [0.3, 1, -0.5], [0.7, 0.4, 0.3], [1, 0, -0.4]] },
    lfo:     { label: 'Wobble', pts: [[0, 0], [0.16, 1, -0.4], [0.33, 0, 0.4], [0.5, -1, -0.4], [0.66, 0, 0.4], [0.83, 1, -0.4], [1, 0]] },
    step:    { label: 'Steps',  pts: [[0, 0.8, 0, true], [0.2, -0.4, 0, true], [0.4, 0.6, 0, true], [0.6, -0.8, 0, true], [0.8, 0.3, 0, true], [1, 0]] }
  };

  E.applyModShape = function (env, key) {
    var shape = E.MOD_SHAPES[key];
    if (!shape) return env;
    env.points = E.make(shape.pts).points;
    return env;
  };

})(typeof window !== 'undefined' ? window : globalThis);
