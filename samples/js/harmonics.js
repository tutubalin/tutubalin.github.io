/* ==========================================================================
   SampleForge — js/harmonics.js
   The harmonic engine.

   Amplitudes and phases of harmonics 1..N are produced by a *rule stack*:
   every rule is an arbitrary expression of the harmonic index `n` that is
   evaluated per harmonic and combined with the running spectrum. That means
   there are no fixed "even / odd / every third" options — anything you can
   write down works, including spectra no traditional waveform has.

   Manual edits (dragging a bar, or drawing in the waveform editor) are stored
   as absolute *overrides* that win over the rules, so a rule stack can stay
   live while individual harmonics are tweaked.
   ========================================================================== */
(function (root) {
  'use strict';

  var SG = (root.SG = root.SG || {});
  var U = SG.util;
  var H = (SG.Harmonics = {});

  var TAU = U.TAU;
  var PHI = (1 + Math.sqrt(5)) / 2;

  /* ------------------------------------------------------- number theory */
  var PRIME_LIMIT = 4096;
  var IS_PRIME = (function () {
    var s = new Uint8Array(PRIME_LIMIT + 1).fill(1);
    s[0] = s[1] = 0;
    for (var i = 2; i * i <= PRIME_LIMIT; i++) if (s[i]) for (var j = i * i; j <= PRIME_LIMIT; j += i) s[j] = 0;
    return s;
  })();

  var FIB_SET = (function () {
    var set = {}, a = 1, b = 1;
    while (a <= 65536) { set[a] = 1; var t = a + b; a = b; b = t; }
    return set;
  })();

  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { var t = b; b = a % b; a = t; } return a; }

  /* --------------------------------------------------------------- helpers */
  /* Everything in this table is available inside rule expressions. */
  var CURRENT = { seed: 0, f: 0, n: 1, N: 1, fund: 0 };

  var HELPERS = {
    /* selection / number theory */
    even: function (n) { return ((n | 0) % 2) === 0; },
    odd: function (n) { return ((n | 0) % 2) !== 0; },
    mod: function (n, k, r) { return ((n | 0) % (k || 1)) === (r || 0); },
    every: function (n, k, r) { return ((n | 0) % (k || 1)) === (r || 0); },
    prime: function (n) { return n <= PRIME_LIMIT ? !!IS_PRIME[n | 0] : false; },
    isFib: function (n) { return !!FIB_SET[n | 0]; },
    gcd: gcd,
    coprime: function (a, b) { return gcd(a, b) === 1; },
    step: function (n, k) { return n >= k; },
    band: function (n, lo, hi) { return n >= lo && n <= hi; },
    /* classic spectra */
    saw: function (n) { return 1 / n; },
    sqr: function (n) { return (((n | 0) % 2) !== 0) ? 1 / n : 0; },
    tri: function (n) { return (((n | 0) % 2) !== 0) ? 1 / (n * n) : 0; },
    pulse: function (n, duty) { return Math.abs(2 / (n * Math.PI) * Math.sin(Math.PI * n * (duty === undefined ? 0.5 : duty))); },
    slope: function (n, s) { return Math.pow(n, -(s === undefined ? 1 : s)); },
    /* shapes / envelopes over the spectrum */
    gauss: function (x, center, width) {
      var w = (width === undefined || width === 0) ? 1e-6 : width;
      var d = (x - center) / w;
      return Math.exp(-0.5 * d * d);
    },
    comb: function (x, spacing, width) {
      var sp = (spacing === undefined || spacing === 0) ? 1 : spacing;
      var w = (width === undefined || width === 0) ? 1e-6 : width;
      var d = ((x % sp) + sp) % sp;                 /* distance into the period */
      d = Math.min(d, sp - d);                      /* distance to nearest multiple */
      return Math.exp(-0.5 * (d / w) * (d / w));
    },
    formant: function (hz, bw) { return HELPERS.gauss(CURRENT.f, hz, bw); },
    sinc: function (x) { return Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x); },
    smoothstep: function (a, b, x) { var t = U.clamp((x - a) / ((b - a) || 1e-9), 0, 1); return t * t * (3 - 2 * t); },
    mix: function (a, b, t) { return a + (b - a) * t; },
    clamp: function (v, a, b) { return v < a ? a : (v > b ? b : v); },
    db: function (x) { return Math.pow(10, x / 20); },
    fract: function (x) { return x - Math.floor(x); },
    /* deterministic noise (reproducible per harmonic index) */
    rand: function (n, seed) { return U.hash01(n, seed === undefined ? CURRENT.seed : seed); },
    noise: function (n, seed) { return U.hash01(n, seed === undefined ? CURRENT.seed : seed); },
    randSigned: function (n, seed) { return U.hashSigned(n, seed === undefined ? CURRENT.seed : seed); },
    pink: function (n, seed) { return U.hash01(n, seed === undefined ? CURRENT.seed : seed) / Math.sqrt(n); },
    brown: function (n, seed) { return U.hash01(n, seed === undefined ? CURRENT.seed : seed) / n; },
    /* math passthrough */
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos,
    atan: Math.atan, atan2: Math.atan2, abs: Math.abs, sign: Math.sign,
    sqrt: Math.sqrt, cbrt: Math.cbrt, exp: Math.exp, log: Math.log, log2: Math.log2,
    log10: Math.log10, pow: Math.pow, min: Math.min, max: Math.max, hypot: Math.hypot,
    floor: Math.floor, ceil: Math.ceil, round: Math.round, trunc: Math.trunc
  };

  var CONSTS = { pi: Math.PI, tau: TAU, e: Math.E, phi: PHI };

  /* One flat scope object holds every helper and constant. Compiled rules get
     it as a hidden first argument and pull the names into local variables with
     a prelude, which keeps evaluation fast and the parameter list legal. */
  var SCOPE = {};
  Object.keys(HELPERS).forEach(function (k) { SCOPE[k] = HELPERS[k]; });
  Object.keys(CONSTS).forEach(function (k) { SCOPE[k] = CONSTS[k]; });
  var SCOPE_NAMES = Object.keys(SCOPE);
  var PRELUDE = 'var ' + SCOPE_NAMES.map(function (k) { return k + '=$$.' + k; }).join(',') + ';';

  var HELPER_NAMES = Object.keys(HELPERS);
  var CONST_NAMES = Object.keys(CONSTS);
  var CTX_NAMES = ['n', 'i', 'f', 'h', 'N', 'fund', 'nyq', 'sr', 'seed'];
  var PARAM_NAMES = ['$$'].concat(CTX_NAMES);

  H.SCOPE_NAMES = SCOPE_NAMES;
  H.CTX_NAMES = CTX_NAMES;

  /* Evaluate a compiled rule for one harmonic. */
  function callRule(fn, n, freq, N, nyq, sr, seed) {
    return fn(SCOPE, n, n - 1, n * freq, N ? n / N : 0, N, freq, nyq, sr, seed);
  }

  /* Docs shown in the in-app reference panel. */
  H.DOCS = [
    {
      title: 'Variables',
      items: [
        ['n', 'harmonic index (1, 2, 3 …)'],
        ['i', 'n - 1, zero-based index'],
        ['f', 'frequency of this harmonic in Hz'],
        ['h', 'n / N, normalised position'],
        ['N', 'total number of harmonics'],
        ['fund', 'fundamental frequency in Hz'],
        ['nyq', 'Nyquist frequency in Hz'],
        ['sr', 'render sample rate'],
        ['seed', 'random seed from the panel']
      ]
    },
    {
      title: 'Selection',
      items: [
        ['even(n) / odd(n)', 'true for even / odd harmonics'],
        ['mod(n, k, r)', 'true when n % k === r'],
        ['prime(n)', 'true for prime harmonic numbers'],
        ['isFib(n)', 'true for 1,2,3,5,8,13,21…'],
        ['coprime(n, k)', 'true when gcd(n,k) === 1'],
        ['band(n, lo, hi)', 'true inside an index range'],
        ['step(n, k)', 'true from harmonic k upwards']
      ]
    },
    {
      title: 'Classic spectra',
      items: [
        ['1/n or saw(n)', 'sawtooth roll-off'],
        ['sqr(n)', 'square: odd only, 1/n'],
        ['tri(n)', 'triangle: odd only, 1/n²'],
        ['pulse(n, duty)', 'pulse wave magnitudes'],
        ['slope(n, s)', 'n^-s, any tilt you like']
      ]
    },
    {
      title: 'Shapes & noise',
      items: [
        ['gauss(x, c, w)', 'bell centred on c (use n or f)'],
        ['comb(x, sp, w)', 'peaks every sp harmonics/Hz'],
        ['formant(hz, bw)', 'bell at a frequency in Hz'],
        ['sinc(x)', 'sin(πx)/(πx)'],
        ['rand(n) / pink(n)', 'seeded noise, 1/f noise'],
        ['smoothstep(a,b,x)', 'soft gate'],
        ['db(x)', 'decibels → linear']
      ]
    },
    {
      title: 'Math',
      items: [
        ['sin cos tan atan2', 'trigonometry (radians)'],
        ['abs sign sqrt cbrt', 'magnitude helpers'],
        ['exp log log2 log10 pow', 'exponentials'],
        ['min max hypot clamp mix', 'combine values'],
        ['floor ceil round fract', 'rounding'],
        ['pi tau e phi', 'constants']
      ]
    }
  ];

  H.RECIPES = [
    { label: 'Sine', expr: 'n === 1 ? 1 : 0', mode: 'set' },
    { label: 'Saw', expr: '1/n', mode: 'set' },
    { label: 'Square (odd only)', expr: 'odd(n) ? 1/n : 0', mode: 'set' },
    { label: 'Triangle', expr: 'odd(n) ? 1/(n*n) : 0', mode: 'set', phase: '0.5*(((n-1)>>1)%2)' },
    { label: 'Even only', expr: 'even(n) ? 1 : 0', mode: 'set' },
    { label: 'Odd only, no tilt', expr: 'odd(n) ? 1 : 0', mode: 'set' },
    { label: 'Every 3rd', expr: 'mod(n,3,0) ? 1 : 0.04', mode: 'set' },
    { label: 'Every 4th, offset 2', expr: 'mod(n,4,2) ? 1/n : 0', mode: 'set' },
    { label: 'Prime harmonics', expr: 'prime(n) ? 1/sqrt(n) : 0.02', mode: 'set' },
    { label: 'Fibonacci', expr: 'isFib(n) ? 1 : 0.06', mode: 'set' },
    { label: 'Coprime with 12', expr: 'coprime(n,12) ? 1/n : 0', mode: 'set' },
    { label: 'Comb / ring-mod flavour', expr: 'comb(n, 7, 1.2)', mode: 'set' },
    { label: 'Formant stack (vowel A)', expr: 'gauss(f,730,90) + 0.55*gauss(f,1090,110) + 0.25*gauss(f,2440,170)', mode: 'set' },
    { label: 'Formant stack (vowel E)', expr: 'gauss(f,400,70) + 0.6*gauss(f,1620,140) + 0.3*gauss(f,2400,180)', mode: 'set' },
    { label: 'Bell-ish partials', expr: 'exp(-n/5) * (0.5 + 0.5*sin(n*1.9))', mode: 'set' },
    { label: 'Sinc window', expr: 'abs(sinc((n-9)/3))', mode: 'set' },
    { label: 'Noise / white', expr: 'rand(n)', mode: 'set', phase: 'rand(n+999)' },
    { label: 'Pink noise', expr: 'pink(n)', mode: 'set', phase: 'rand(n+7)' },
    { label: 'Octaves only', expr: 'mod(i,12,0) ? 1 : 0.05', mode: 'set' },
    { label: 'Quartal (5ths)', expr: 'mod(n,3,1) ? 1/n : 0', mode: 'set' },
    { label: 'Beat pairs', expr: 'gauss(n, N*0.5, 1.6) + gauss(n, N*0.5+1, 1.6)', mode: 'set' },
    { label: 'Sub + air', expr: 'n < 3 ? 1 : 0.05 + 0.95*smoothstep(N*0.6, N, n)', mode: 'set' },
    { label: 'Tilt only (brighten)', expr: 'slope(n, 0.5)', mode: 'mul' },
    { label: 'Notch out 5–8', expr: 'band(n,5,8) ? 0.05 : 1', mode: 'mul' }
  ];

  /* ------------------------------------------------------------ compiling */
  var COMPILE_CACHE = new Map();

  H.compile = function (expr) {
    var cached = COMPILE_CACHE.get(expr);
    if (cached) return cached;
    var res;
    try {
      /* The user expression is parsed once and wrapped so a syntax error is
         reported next to the rule instead of breaking the app. The prelude
         turns the shared scope object into local variables. */
      /* eslint-disable-next-line no-new-func */
      var fn = new Function(PARAM_NAMES, '"use strict";' + PRELUDE + 'return (' + expr + ');');
      res = { fn: fn, error: null, expr: expr };
    } catch (err) {
      res = { fn: null, error: (err && err.message) ? err.message : String(err), expr: expr };
    }
    if (COMPILE_CACHE.size > 400) COMPILE_CACHE.clear();
    COMPILE_CACHE.set(expr, res);
    return res;
  };

  /* Safety net: make sure every helper is actually reachable from an expression. */
  H.selfTest = function () {
    var bad = [];
    SCOPE_NAMES.forEach(function (name) {
      var compiled = H.compile(name + (typeof SCOPE[name] === 'function' ? '(1, 1, 1)' : ''));
      if (compiled.error) { bad.push(name + ': ' + compiled.error); return; }
      try {
        var out = callRule(compiled.fn, 3, 261.6, 32, 22050, 44100, 1234);
        if (typeof out !== 'number' && typeof out !== 'boolean') bad.push(name + ': returned ' + typeof out);
      } catch (err) {
        bad.push(name + ': ' + err.message);
      }
    });
    return bad;
  };

  /* ------------------------------------------------------- sparse overrides */
  /* Overrides are stored as sorted sparse arrays: [{ n, v }] */
  H.getOverride = function (list, n) {
    if (!list || !list.length) return null;
    for (var i = 0; i < list.length; i++) if (list[i].n === n) return list[i].v;
    return null;
  };

  H.setOverride = function (list, n, v) {
    var out = list ? list.slice() : [];
    for (var i = 0; i < out.length; i++) {
      if (out[i].n === n) {
        if (v === null || v === undefined) out.splice(i, 1);
        else out[i] = { n: n, v: v };
        return out;
      }
    }
    if (v !== null && v !== undefined) out.push({ n: n, v: v });
    out.sort(function (a, b) { return a.n - b.n; });
    return out;
  };

  H.clearOverride = function (list, n) { return H.setOverride(list, n, null); };

  H.densify = function (list, N) {
    var out = new Float64Array(N + 1).fill(NaN);
    if (list) for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (o && o.n >= 1 && o.n <= N && isFinite(o.v)) out[o.n] = o.v;
    }
    return out;
  };

  H.overrideCount = function (list, N) {
    if (!list) return 0;
    var c = 0;
    for (var i = 0; i < list.length; i++) if (list[i].n <= N) c++;
    return c;
  };

  /* ------------------------------------------------------ spectrum pipeline */
  var COMBINE = {
    set: function (a, v) { return v; },
    mul: function (a, v) { return a * v; },
    add: function (a, v) { return a + v; },
    max: function (a, v) { return a > v ? a : v; },
    min: function (a, v) { return a < v ? a : v; }
  };
  H.MODES = ['set', 'mul', 'add', 'max', 'min'];

  function basePhaseTurns(mode, n, seed) {
    switch (mode) {
      case 'cos': return 0.25;
      case 'alt': return ((n - 1) % 2) * 0.5;
      case 'rand': return U.hash01(n * 31 + 7, seed);
      case 'golden': return (n * (PHI - 1)) % 1;
      case 'zero':
      default: return 0;
    }
  }
  H.PHASE_BASES = ['zero', 'cos', 'alt', 'rand', 'golden'];

  var spectrumCache = { key: '', value: null };

  function signature(state, freq, sr) {
    var h = state.harmonics;
    var s = h.count + '|' + h.normalize + '|' + h.phaseBase + '|' + h.seed + '|' + (h.antiAlias ? 1 : 0) +
      '|' + (freq ? freq.toFixed(4) : '-') + '|' + sr;
    var rules = h.rules || [];
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      s += '#' + (r.enabled ? 1 : 0) + (r.amp || '') + (r.mode || 'set') + (r.amount === undefined ? 1 : r.amount) +
        (r.phase || '') + (r.phaseMode || 'add');
    }
    s += '@' + JSON.stringify(h.overrides.amp) + '@' + JSON.stringify(h.overrides.phase);
    return s;
  }

  /* Returns the complete spectrum for the current patch.
     freq / sampleRate are needed for the optional Nyquist band-limiting. */
  H.computeSpectrum = function (state, freq, sampleRate) {
    var key = signature(state, freq, sampleRate);
    if (spectrumCache.key === key && spectrumCache.value) return spectrumCache.value;

    var h = state.harmonics;
    var N = U.clamp(h.count | 0, 2, 128);
    var seed = (h.seed | 0) || 0;
    var amp = new Float64Array(N + 1);
    var phase = new Float64Array(N + 1);
    var base = new Float64Array(N + 1);      /* rule result, normalised, pre-override */
    var basePhase = new Float64Array(N + 1);
    var overridden = new Uint8Array(N + 1);
    var phaseOverridden = new Uint8Array(N + 1);
    var errors = [];
    var n, i, r;

    for (n = 1; n <= N; n++) amp[n] = 1;

    /* --- rules --- */
    var rules = h.rules || [];
    for (i = 0; i < rules.length; i++) {
      r = rules[i];
      if (!r.enabled) continue;
      var expr = String(r.amp === undefined || r.amp === null ? '' : r.amp).trim();
      if (!expr) continue;
      var compiled = H.compile(expr);
      if (compiled.error) { errors.push({ rule: r.id, index: i, field: 'amp', message: compiled.error }); continue; }
      var amount = (r.amount === undefined || r.amount === null || !isFinite(r.amount)) ? 1 : r.amount;
      var combine = COMBINE[r.mode] || COMBINE.set;
      var badValues = 0, threw = false;
      var nyqHz = (sampleRate || 44100) / 2, srHz = sampleRate || 44100, fundHz = freq || 0;
      for (n = 1; n <= N; n++) {
        CURRENT.seed = seed; CURRENT.n = n; CURRENT.N = N;
        CURRENT.fund = fundHz; CURRENT.f = n * fundHz;
        var v;
        try {
          v = callRule(compiled.fn, n, fundHz, N, nyqHz, srHz, seed);
        } catch (err) {
          errors.push({
            rule: r.id, index: i, field: 'amp',
            message: 'at n=' + n + ': ' + ((err && err.message) || String(err))
          });
          threw = true;
          break;                      /* later harmonics keep the previous value */
        }
        if (typeof v === 'boolean') v = v ? 1 : 0;
        if (typeof v !== 'number' || !isFinite(v)) { badValues++; v = 0; }
        amp[n] = combine(amp[n], v * amount);
      }
      if (!threw && badValues > 0) {
        errors.push({
          rule: r.id, index: i, field: 'amp',
          message: badValues === N ? 'expression never returns a finite number (all harmonics set to 0)'
            : badValues + ' non-finite value(s) treated as 0'
        });
      }

      /* optional per-rule phase expression, in turns (1 = 360°) */
      var pexpr = String(r.phase || '').trim();
      if (pexpr) {
        var pc = H.compile(pexpr);
        if (pc.error) errors.push({ rule: r.id, index: i, field: 'phase', message: pc.error });
        else {
          var pset = r.phaseMode === 'set';
          for (n = 1; n <= N; n++) {
            CURRENT.seed = seed; CURRENT.n = n; CURRENT.N = N;
            CURRENT.fund = fundHz; CURRENT.f = n * fundHz;
            var pv;
            try {
              pv = callRule(pc.fn, n, fundHz, N, nyqHz, srHz, seed);
            } catch (err2) {
              errors.push({ rule: r.id, index: i, field: 'phase', message: (err2 && err2.message) || String(err2) });
              break;
            }
            if (typeof pv === 'boolean') pv = pv ? 1 : 0;
            if (typeof pv !== 'number' || !isFinite(pv)) pv = 0;
            phase[n] = pset ? pv : phase[n] + pv;
          }
        }
      }
    }

    /* --- negative amplitudes = polarity flip --- */
    for (n = 1; n <= N; n++) {
      if (amp[n] < 0) { amp[n] = -amp[n]; phase[n] += 0.5; }
      phase[n] += basePhaseTurns(h.phaseBase, n, seed);
    }

    /* --- normalisation of the rule result --- */
    var scale = 1;
    if (h.normalize === 'peak') {
      var mx = 0;
      for (n = 1; n <= N; n++) if (amp[n] > mx) mx = amp[n];
      scale = mx > 1e-12 ? 1 / mx : 1;
    } else if (h.normalize === 'rms') {
      var sq = 0;
      for (n = 1; n <= N; n++) sq += amp[n] * amp[n];
      scale = sq > 1e-12 ? 1 / Math.sqrt(sq) : 1;
    } else if (h.normalize === 'sum') {
      var sm = 0;
      for (n = 1; n <= N; n++) sm += amp[n];
      scale = sm > 1e-12 ? 1 / sm * Math.min(N, 8) : 1;   /* keep broadband spectra usable */
    }
    for (n = 1; n <= N; n++) {
      amp[n] *= scale;
      base[n] = amp[n];
      basePhase[n] = phase[n];
    }

    /* --- manual overrides (bars + waveform drawing) win over the rules --- */
    var ampOv = H.densify(h.overrides.amp, N);
    var phOv = H.densify(h.overrides.phase, N);
    for (n = 1; n <= N; n++) {
      if (!isNaN(ampOv[n])) { amp[n] = U.clamp(ampOv[n], 0, 4); overridden[n] = 1; }
      if (!isNaN(phOv[n])) { phase[n] = phOv[n]; phaseOverridden[n] = 1; }
    }

    /* --- band limiting --- */
    var nyq = (sampleRate || 44100) / 2;
    var nyquistN = freq > 0 ? Math.floor(nyq / freq) : N;
    var muted = new Uint8Array(N + 1);
    for (n = 1; n <= N; n++) if (n > nyquistN) muted[n] = 1;
    var outAmp = new Float64Array(N + 1);
    for (n = 1; n <= N; n++) outAmp[n] = (h.antiAlias && muted[n]) ? 0 : amp[n];

    /* --- wrap phases --- */
    for (n = 1; n <= N; n++) phase[n] = ((phase[n] % 1) + 1) % 1;

    var result = {
      N: N,
      amp: outAmp,           /* what is audible (band-limited) */
      ampRaw: amp,           /* full spectrum incl. above-Nyquist harmonics */
      base: base,            /* rule output before overrides (for display) */
      phase: phase,          /* turns */
      basePhase: basePhase,
      overridden: overridden,
      phaseOverridden: phaseOverridden,
      muted: muted,
      nyquistN: nyquistN,
      freq: freq || 0,
      sampleRate: sampleRate || 44100,
      errors: errors,
      scale: scale
    };
    result.wavePeak = H.peakOfSpectrum(result.amp, result.phase, N);
    result.activeCount = (function () { var c = 0; for (var k = 1; k <= N; k++) if (result.amp[k] > 1e-6) c++; return c; })();

    spectrumCache.key = key;
    spectrumCache.value = result;
    return result;
  };

  H.invalidate = function () { spectrumCache.key = ''; spectrumCache.value = null; };

  /* ------------------------------------------------------- waveform <--> DFT */
  var DFT_M = 512;
  H.DFT_M = DFT_M;
  var tableCache = { key: '', cos: null, sin: null, N: 0, M: 0 };

  function dftTables(N, M) {
    var key = N + 'x' + M;
    if (tableCache.key === key) return tableCache;
    var cos = new Float64Array(N * M), sin = new Float64Array(N * M);
    for (var n = 1; n <= N; n++) {
      var off = (n - 1) * M;
      for (var m = 0; m < M; m++) {
        var a = TAU * n * m / M;
        cos[off + m] = Math.cos(a);
        sin[off + m] = Math.sin(a);
      }
    }
    tableCache = { key: key, cos: cos, sin: sin, N: N, M: M };
    return tableCache;
  }

  /* One cycle of the waveform, sampled M times. */
  /* Synthesise one cycle. Each partial is a rotating phasor stepped through the
     table instead of M*N sin()/cos() calls: this keeps the waveform redraw and
     the auto-trim peak scan cheap even at 128 harmonics. */
  H.waveformFromSpectrum = function (amp, phaseTurns, N, M) {
    M = M || 1024;
    var out = new Float32Array(M);
    var step = TAU / M;
    for (var n = 1; n <= N; n++) {
      var a = amp[n];
      if (!a || !isFinite(a)) continue;
      var th = ((phaseTurns ? phaseTurns[n] : 0) % 1) * TAU;
      var cr = Math.cos(n * step), sr = Math.sin(n * step);
      var x = Math.cos(th), y = Math.sin(th);
      for (var m = 0; m < M; m++) {
        out[m] += a * y;
        var nx = x * cr - y * sr;
        y = x * sr + y * cr;
        x = nx;
      }
    }
    return out;
  };

  H.peakOfSpectrum = function (amp, phaseTurns, N) {
    var M = 512, peak = 0;
    var wave = H.waveformFromSpectrum(amp, phaseTurns, N, M);
    for (var m = 0; m < M; m++) { var v = Math.abs(wave[m]); if (v > peak) peak = v; }
    return peak;
  };

  /* Analysis of a drawn cycle → amplitudes (peak-normalised) + phases in turns. */
  H.spectrumFromWaveform = function (wave, N) {
    var M = wave.length;
    var t = dftTables(N, M);
    var amp = new Float64Array(N + 1), phase = new Float64Array(N + 1);
    var peak = 0;
    for (var n = 1; n <= N; n++) {
      var off = (n - 1) * M, A = 0, B = 0;
      for (var m = 0; m < M; m++) {
        A += wave[m] * t.cos[off + m];
        B += wave[m] * t.sin[off + m];
      }
      A *= 2 / M; B *= 2 / M;
      var mag = Math.sqrt(A * A + B * B);
      amp[n] = mag;
      /* y = Σ amp·sin(2πnφ + p) → B = amp·cos p, A = amp·sin p */
      phase[n] = (mag < 1e-9 ? 0 : Math.atan2(A, B) / TAU);
      if (mag > peak) peak = mag;
    }
    if (peak > 1e-9) for (var k = 1; k <= N; k++) amp[k] /= peak;
    return { amp: amp, phase: phase, peak: peak, N: N, M: M };
  };

  /* ------------------------------------------------------------- wave tools */
  /* Operations on a drawn cycle (used by the waveform editor buttons). */
  H.WaveOps = {
    smooth: function (wave, passes) {
      passes = passes || 1;
      var out = Float32Array.from(wave), M = wave.length;
      for (var p = 0; p < passes; p++) {
        var src = Float32Array.from(out);
        for (var m = 0; m < M; m++) {
          var a = src[(m - 1 + M) % M], b = src[m], c = src[(m + 1) % M];
          out[m] = (a + 2 * b + c) / 4;
        }
      }
      return out;
    },
    invert: function (wave) { var o = new Float32Array(wave.length); for (var i = 0; i < wave.length; i++) o[i] = -wave[i]; return o; },
    flip: function (wave) { var o = new Float32Array(wave.length); for (var i = 0; i < wave.length; i++) o[i] = wave[wave.length - 1 - i]; return o; },
    removeDC: function (wave) {
      var mean = 0, i;
      for (i = 0; i < wave.length; i++) mean += wave[i];
      mean /= wave.length;
      var o = new Float32Array(wave.length);
      for (i = 0; i < wave.length; i++) o[i] = wave[i] - mean;
      return o;
    },
    normalize: function (wave) {
      var peak = 0, i;
      for (i = 0; i < wave.length; i++) { var a = Math.abs(wave[i]); if (a > peak) peak = a; }
      if (peak < 1e-9) return Float32Array.from(wave);
      var o = new Float32Array(wave.length);
      for (i = 0; i < wave.length; i++) o[i] = wave[i] / peak;
      return o;
    },
    mirror: function (wave) {
      /* odd symmetry: second half = negated, reversed first half */
      var M = wave.length, o = new Float32Array(M), half = M >> 1;
      for (var i = 0; i < half; i++) { o[i] = wave[i]; o[M - 1 - i] = -wave[i]; }
      return o;
    }
  };

})(typeof window !== 'undefined' ? window : globalThis);
