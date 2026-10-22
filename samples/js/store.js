/* ==========================================================================
   SampleForge — js/store.js
   Single source of truth: the patch state, plus undo/redo, JSON import/export
   and shareable URL hashes. Everything is plain JSON so snapshots are cheap.
   ========================================================================== */
(function (root) {
  'use strict';

  var SG = (root.SG = root.SG || {});
  var U = SG.util;
  var E = SG.Envelope;
  var S = (SG.Store = {});

  /* ------------------------------------------------------------- defaults */
  function defaults() {
    return {
      version: 1,
      name: 'SampleForge patch',
      note: { midi: 60 },
      transport: { loop: false, volume: 0.8 },
      voice: { unison: 1, spread: 12, stereo: true, autoTrim: true },
      sample: {
        sampleRate: 44100, duration: 1.2, bitDepth: 16, mono: false,
        normalize: true, peak: 0.98, fadeIn: 1, fadeOut: 5, tail: 0.06,
        filename: 'sampleforge'
      },
      harmonics: {
        count: 24, normalize: 'peak', phaseBase: 'zero', seed: 1337, antiAlias: true,
        drawn: false,
        rules: [{ id: U.uid('rule'), enabled: true, amp: 'odd(n) ? 1/n : 0', mode: 'set', amount: 1, phase: '', phaseMode: 'add' }],
        overrides: { amp: [], phase: [] }
      },
      envelopes: {
        amp: {
          enabled: true,
          points: [{ t: 0, v: 0, c: 0.6, hold: false }, { t: 0.012, v: 1, c: 0.45, hold: false },
            { t: 0.38, v: 0.68, c: -0.35, hold: false }, { t: 1, v: 0, c: -0.6, hold: false }]
        },
        pitch: {
          enabled: false, depth: 12,
          points: [{ t: 0, v: 0, c: 0, hold: false }, { t: 1, v: 0, c: 0, hold: false }]
        },
        filter: {
          enabled: false, depth: 4,
          points: [{ t: 0, v: 0.8, c: 0.4, hold: false }, { t: 0.4, v: 0, c: -0.5, hold: false },
            { t: 1, v: -0.3, c: -0.3, hold: false }]
        }
      },
      filter: { enabled: false, type: 'lowpass', cutoff: 4200, q: 1 },
      ui: { envTab: 'amp', waveTool: 'draw', showPhase: true, snap: true, mirror: false, keyRoot: 48 }
    };
  }
  S.defaults = defaults;

  /* Envelope editor configuration per destination (shared by UI + editors). */
  S.ENV_CONFIG = {
    amp: {
      key: 'amp', label: 'Amplitude', bipolar: false, min: 0, max: 1,
      unit: function (v) { return U.fmt.pct(v, 0) + '  ·  ' + U.fmt.db(v); },
      shapes: E.SHAPES, shapeFn: 'applyShape', color: 'var(--env)',
      describe: function (v) { return U.fmt.pct(v, 0) + ' (' + U.fmt.db(v) + ')'; },
      axis: function (v) { return Math.round(v * 100) + '%'; }
    },
    pitch: {
      key: 'pitch', label: 'Pitch', bipolar: true, min: -1, max: 1,
      unit: function (v, st) { return U.fmt.semis(v * (st ? st.envelopes.pitch.depth : 12)); },
      shapes: E.MOD_SHAPES, shapeFn: 'applyModShape', color: 'var(--voice)',
      depthLabel: 'Range (semitones)', depthMin: 0.1, depthMax: 48, depthStep: 0.1,
      describe: function (v, st) { return U.fmt.semis(v * st.envelopes.pitch.depth); },
      axis: function (v, st) {
        var s = v * st.envelopes.pitch.depth;
        return (s > 0 ? '+' : '') + s.toFixed(Math.abs(s) < 10 ? 1 : 0) + 'st';
      }
    },
    filter: {
      key: 'filter', label: 'Filter', bipolar: true, min: -1, max: 1,
      unit: function (v, st) { return U.fmt.num(Math.pow(2, v * (st ? st.envelopes.filter.depth : 4)), 2) + '× cutoff'; },
      shapes: E.MOD_SHAPES, shapeFn: 'applyModShape', color: 'var(--harm)',
      depthLabel: 'Range (octaves)', depthMin: 0.5, depthMax: 8, depthStep: 0.1,
      describe: function (v, st) { return U.fmt.num(Math.pow(2, v * st.envelopes.filter.depth), 2) + '× cutoff'; },
      axis: function (v, st) {
        var m = Math.pow(2, v * st.envelopes.filter.depth);
        return (m >= 10 ? m.toFixed(0) : m.toFixed(1)) + '×';
      }
    }
  };

  /* ----------------------------------------------------------------- state */
  S.state = defaults();
  S.listeners = [];

  S.subscribe = function (fn) { S.listeners.push(fn); return function () {
    var i = S.listeners.indexOf(fn); if (i >= 0) S.listeners.splice(i, 1);
  }; };

  S.notify = function (reason) {
    for (var i = 0; i < S.listeners.length; i++) {
      try { S.listeners[i](reason || 'change', S.state); } catch (err) { console.error('[SampleForge] listener error', err); }
    }
  };

  /* --------------------------------------------------------------- undo/redo */
  var undoStack = [], redoStack = [];
  var UNDO_LIMIT = 120;
  var GESTURE_GAP = 2000;                                  /* ms of quiet = new gesture */
  var gesture = { armed: false, snapshotted: false, at: 0 };

  function snapshot() { return U.deepClone(S.state); }

  function pushSnapshot() {
    undoStack.push(snapshot());
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
  }

  S.pushUndo = function () {
    pushSnapshot();
    gesture.snapshotted = false;       /* a discrete step closes any coalescing */
  };

  /* Snapshot lazily, at the first mutation of a gesture. Taking it here (rather
     than on pointerdown/focus) means a control that never blurs can't swallow
     the undo step of whatever the user does next, and a long pause inside one
     drag still starts a fresh step. */
  function ensureSnapshot() {
    var now = Date.now();
    if (!gesture.snapshotted || (now - gesture.at) > GESTURE_GAP) pushSnapshot();
    gesture.snapshotted = true;
    gesture.at = now;
  }

  /* Group a drag into a single undo step. */
  S.beginGesture = function () { gesture.armed = true; };
  S.endGesture = function () { gesture.armed = false; gesture.snapshotted = false; };
  S.gestureActive = function () { return gesture.armed; };

  S.canUndo = function () { return undoStack.length > 0; };
  S.canRedo = function () { return redoStack.length > 0; };

  S.undo = function () {
    if (!undoStack.length) return false;
    redoStack.push(snapshot());
    S.state = undoStack.pop();
    gesture.snapshotted = false;
    SG.Harmonics.invalidate();
    S.notify('undo');
    return true;
  };

  S.redo = function () {
    if (!redoStack.length) return false;
    undoStack.push(snapshot());
    S.state = redoStack.pop();
    gesture.snapshotted = false;
    SG.Harmonics.invalidate();
    S.notify('redo');
    return true;
  };

  /* ------------------------------------------------------------- mutations */
  /* update(fn)                 — one undo step
     updateTransient(fn)        — no undo step (use inside a gesture) */
  S.update = function (fn, opts) {
    if (!opts || opts.undo !== false) S.pushUndo();
    fn(S.state);
    SG.Harmonics.invalidate();
    S.notify('update');
  };

  S.updateTransient = function (fn) {
    if (gesture.armed) ensureSnapshot();
    fn(S.state);
    SG.Harmonics.invalidate();
    S.notify('transient');
  };

  S.setUI = function (fn) {          /* UI-only tweaks: no undo entry */
    fn(S.state.ui);
    S.notify('ui');
  };

  /* --------------------------------------------------------- patch loading */
  function sanitize(state) {
    var d = defaults();
    var s = U.mergeDeep(d, state || {});

    s.note.midi = U.clamp(Math.round(s.note.midi || 60), 0, 127);
    s.transport.volume = U.clamp(+s.transport.volume || 0, 0, 1);
    s.voice.unison = U.clamp(Math.round(+s.voice.unison || 1), 1, 5);
    s.voice.spread = U.clamp(+s.voice.spread || 0, 0, 200);
    s.sample.duration = U.clamp(+s.sample.duration || 1, 0.01, 30);
    s.sample.sampleRate = [22050, 44100, 48000, 88200, 96000].indexOf(+s.sample.sampleRate) >= 0 ? +s.sample.sampleRate : 44100;
    s.sample.bitDepth = [16, 24, 32].indexOf(+s.sample.bitDepth) >= 0 ? +s.sample.bitDepth : 16;
    s.sample.peak = U.clamp(+s.sample.peak || 0.98, 0.05, 1);
    s.sample.fadeIn = U.clamp(+s.sample.fadeIn || 0, 0, 500);
    s.sample.fadeOut = U.clamp(+s.sample.fadeOut || 0, 0, 2000);
    s.filter.cutoff = U.clamp(+s.filter.cutoff || 1000, 10, 100000);
    s.filter.q = U.clamp(+s.filter.q || 1, 0.0001, 40);

    var h = s.harmonics;
    h.count = U.clamp(Math.round(+h.count || 16), 2, 128);
    h.seed = Math.round(+h.seed || 0);
    if (['peak', 'rms', 'sum', 'none'].indexOf(h.normalize) < 0) h.normalize = 'peak';
    if (SG.Harmonics.PHASE_BASES.indexOf(h.phaseBase) < 0) h.phaseBase = 'zero';
    if (!Array.isArray(h.rules)) h.rules = d.harmonics.rules;
    h.rules = h.rules.map(function (r) {
      return {
        id: r.id || U.uid('rule'),
        enabled: r.enabled !== false,
        amp: typeof r.amp === 'string' ? r.amp : '',
        mode: SG.Harmonics.MODES.indexOf(r.mode) >= 0 ? r.mode : 'set',
        amount: isFinite(+r.amount) ? U.clamp(+r.amount, -4, 4) : 1,
        phase: typeof r.phase === 'string' ? r.phase : '',
        phaseMode: r.phaseMode === 'set' ? 'set' : 'add'
      };
    });
    if (!h.rules.length) h.rules = d.harmonics.rules;
    if (!h.overrides || typeof h.overrides !== 'object') h.overrides = { amp: [], phase: [] };
    h.overrides.amp = cleanOverrides(h.overrides.amp, h.count);
    h.overrides.phase = cleanOverrides(h.overrides.phase, h.count);

    ['amp', 'pitch', 'filter'].forEach(function (key) {
      var env = s.envelopes[key] || (s.envelopes[key] = {});
      var cfg = S.ENV_CONFIG[key];
      env.enabled = key === 'amp' ? true : !!env.enabled;
      if (key !== 'amp') env.depth = U.clamp(+env.depth || (key === 'pitch' ? 12 : 4), cfg.depthMin, cfg.depthMax);
      if (!Array.isArray(env.points) || env.points.length < 2) env.points = U.deepClone(defaults().envelopes[key].points);
      env.points = env.points.map(function (p) {
        return {
          t: U.clamp(+p.t || 0, 0, 1),
          v: U.clamp(isFinite(+p.v) ? +p.v : 0, cfg.min, cfg.max),
          c: U.clamp(isFinite(+p.c) ? +p.c : 0, -1, 1),
          hold: !!p.hold
        };
      }).sort(function (a, b) { return a.t - b.t; });
      env.points[0].t = 0;
      env.points[env.points.length - 1].t = 1;
      /* collapse duplicates */
      for (var i = env.points.length - 1; i > 0; i--) {
        if (env.points[i].t - env.points[i - 1].t < 1e-4) env.points.splice(i, 1);
      }
      if (env.points.length < 2) env.points = U.deepClone(defaults().envelopes[key].points);
    });

    if (['lowpass', 'highpass', 'bandpass', 'notch', 'peaking', 'lowshelf', 'highshelf', 'allpass'].indexOf(s.filter.type) < 0) {
      s.filter.type = 'lowpass';
    }
    if (!s.ui || typeof s.ui !== 'object') s.ui = d.ui;
    return s;
  }

  function cleanOverrides(list, count) {
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (!o || !isFinite(o.n) || !isFinite(o.v)) continue;
      var n = Math.round(o.n);
      if (n < 1 || n > count) continue;
      out.push({ n: n, v: +o.v });
    }
    out.sort(function (a, b) { return a.n - b.n; });
    return out;
  }
  S.sanitize = sanitize;

  S.loadPatch = function (patch, opts) {
    var next = sanitize(patch);
    if (!opts || opts.undo !== false) S.pushUndo();
    S.state = next;
    SG.Harmonics.invalidate();
    S.notify('patch');
    return S.state;
  };

  S.reset = function () { return S.loadPatch(defaults()); };

  /* ------------------------------------------------------ serialisation */
  S.toJSON = function (pretty) {
    return JSON.stringify(S.state, null, pretty ? 2 : 0);
  };

  S.fromJSON = function (text) {
    var data = JSON.parse(text);
    if (!data || typeof data !== 'object') throw new Error('not a patch object');
    return S.loadPatch(data);
  };

  function b64encode(str) {
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return root.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64decode(str) {
    var b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = root.atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  S.toHash = function () { return '#p=' + b64encode(S.toJSON(false)); };

  S.fromHash = function (hash) {
    var h = String(hash || root.location && root.location.hash || '');
    if (!h || h.indexOf('#p=') !== 0) return false;
    try {
      var json = b64decode(h.slice(3));
      S.state = sanitize(JSON.parse(json));
      SG.Harmonics.invalidate();
      return true;
    } catch (err) {
      console.warn('[SampleForge] could not read patch from URL', err);
      return false;
    }
  };

  S.writeHash = function () {
    try {
      if (root.history && root.history.replaceState) root.history.replaceState(null, '', S.toHash());
      else root.location.hash = S.toHash();
    } catch (err) { /* file:// or sandboxed frames may refuse */ }
  };

})(typeof window !== 'undefined' ? window : globalThis);
