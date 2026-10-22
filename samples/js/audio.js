/* ==========================================================================
   SampleForge — js/audio.js
   The audio engine. One function builds the voice graph, and it is used for
   both live playback (AudioContext) and the offline render/export
   (OfflineAudioContext) — so what you hear is exactly what the WAV contains.

   voice graph:  oscillator(s) ─► unison sum ─► filter ─► amp envelope ─► out
   Envelopes are handed to the AudioParams with setValueCurveAtTime(), sampled
   straight from the breakpoint model, which reproduces any curve exactly.
   ========================================================================== */
(function (root) {
  'use strict';

  var SG = (root.SG = root.SG || {});
  var U = SG.util;
  var E = SG.Envelope;
  var A = (SG.Audio = {});

  A.ctx = null;
  A.master = null;
  A.analyser = null;
  A.playing = false;
  A.loop = false;
  A.midi = 60;
  A.error = null;

  A.stateProvider = function () { return SG.Store.state; };

  var activeVoices = [];
  var timer = null;
  var nextTime = 0, startTime = 0, endTime = 0, iteration = 0;
  var analyserData = null;

  /* ---------------------------------------------------------------- context */
  A.ensureCtx = function () {
    if (A.ctx) {
      if (A.ctx.state === 'suspended') A.ctx.resume().catch(function () {});
      return A.ctx;
    }
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) {
      A.error = 'Web Audio is not available in this browser.';
      return null;
    }
    try {
      A.ctx = new AC({ latencyHint: 'interactive' });
    } catch (e) {
      A.ctx = new AC();
    }
    A.master = A.ctx.createGain();
    A.master.gain.value = SG.Store.state.transport.volume;
    A.analyser = A.ctx.createAnalyser();
    A.analyser.fftSize = 1024;
    A.analyser.smoothingTimeConstant = 0.4;
    analyserData = new Float32Array(A.analyser.fftSize);
    A.master.connect(A.analyser);
    A.analyser.connect(A.ctx.destination);
    A.error = null;
    return A.ctx;
  };

  A.setVolume = function (v) {
    if (!A.master) return;
    A.master.gain.setTargetAtTime(U.clamp(v, 0, 1), A.ctx.currentTime, 0.01);
  };

  A.getLevel = function () {
    if (!A.analyser || !analyserData) return { peak: 0, rms: 0 };
    A.analyser.getFloatTimeDomainData(analyserData);
    var peak = 0, sum = 0;
    for (var i = 0; i < analyserData.length; i++) {
      var v = analyserData[i], a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sum += v * v;
    }
    return { peak: peak, rms: Math.sqrt(sum / analyserData.length) };
  };

  /* ------------------------------------------------------------ voice graph */
  function makePeriodicWave(ctx, sp, trim) {
    var N = sp.N;
    var real = new Float32Array(N + 1);
    var imag = new Float32Array(N + 1);
    var total = 0;
    for (var n = 1; n <= N; n++) {
      var a = sp.amp[n] * trim;
      if (!a || !isFinite(a)) continue;
      total += a;
      var p = sp.phase[n] * U.TAU;
      imag[n] = a * Math.cos(p);      /* sin component */
      real[n] = a * Math.sin(p);      /* cos component */
    }
    /* Some engines reject an all-zero wave; -120 dB is inaudible and safe. */
    if (total <= 0) imag[1] = 1e-6;
    var opts = { disableNormalization: true };
    try {
      return ctx.createPeriodicWave(real, imag, opts);
    } catch (e) {
      try { return ctx.createPeriodicWave(real, imag); } catch (e2) { return null; }
    }
  }

  /* Build a curve once (it can then drive several params, e.g. one per unison
     voice) and scrub any non-finite value the browser would reject. */
  function makeCurve(env, length, mapFn) {
    var curve = mapFn ? E.sampleCurveMapped(env, length, mapFn) : E.sampleCurve(env, length);
    for (var i = 0; i < curve.length; i++) if (!isFinite(curve[i])) curve[i] = 0;
    return curve;
  }

  function setCurve(param, curve, when, duration) {
    try {
      param.setValueCurveAtTime(curve, when, duration);
      return true;
    } catch (e) {
      /* Very old implementations: fall back to a coarse ramp sequence. */
      try {
        var steps = Math.min(64, curve.length);
        param.setValueAtTime(curve[0], when);
        for (var s = 1; s < steps; s++) {
          var value = curve[Math.round(s * (curve.length - 1) / (steps - 1))];
          param.linearRampToValueAtTime(value === 0 ? 1e-6 : value, when + duration * s / (steps - 1));
        }
        return true;
      } catch (e2) { return false; }
    }
  }

  /* Builds one voice at `when` and returns the nodes it created. */
  A.buildVoice = function (ctx, dest, state, when, freq, opts) {
    opts = opts || {};
    var created = [];
    var dur = Math.max(0.005, state.sample.duration);
    var tail = 0.006;
    var sp = SG.Harmonics.computeSpectrum(state, freq, ctx.sampleRate);
    var trim = state.voice.autoTrim ? 1 / Math.max(1, sp.wavePeak) : 1;

    var wave = makePeriodicWave(ctx, sp, trim);
    var voices = U.clamp(state.voice.unison | 0, 1, 5);
    var usePan = !!opts.pan && voices > 1 && typeof ctx.createStereoPanner === 'function';

    var sum = ctx.createGain();
    sum.gain.value = voices > 1 ? 1 / Math.sqrt(voices) : 1;
    created.push(sum);

    /* --- envelope curves (built once, shared by every voice) --- */
    var curveLen = E.curveLength(dur);
    var pitchEnv = state.envelopes.pitch;
    var pitchCurve = (pitchEnv && pitchEnv.enabled && pitchEnv.points.length > 1)
      ? makeCurve(pitchEnv, curveLen, function (val) { return freq * Math.pow(2, val * pitchEnv.depth / 12); })
      : null;
    var fEnv = state.envelopes.filter;
    var nyqLimit = ctx.sampleRate * 0.495;
    var cutoff = U.clamp(state.filter.cutoff, 10, nyqLimit);
    var filterCurve = (state.filter.enabled && fEnv && fEnv.enabled && fEnv.points.length > 1)
      ? makeCurve(fEnv, curveLen, function (val) { return U.clamp(cutoff * Math.pow(2, val * fEnv.depth), 10, nyqLimit); })
      : null;
    var ampEnv = state.envelopes.amp;
    var ampCurve = (ampEnv && ampEnv.points.length > 1) ? makeCurve(ampEnv, curveLen, null) : null;

    for (var v = 0; v < voices; v++) {
      var osc = ctx.createOscillator();
      created.push(osc);
      if (wave) osc.setPeriodicWave(wave); else osc.type = 'sine';

      if (pitchCurve) setCurve(osc.frequency, pitchCurve, when, dur);
      else osc.frequency.setValueAtTime(freq, when);

      var detune = 0;
      if (voices > 1) detune = state.voice.spread * (v / (voices - 1) - 0.5);
      osc.detune.setValueAtTime(detune, when);

      var node = osc;
      if (usePan) {
        var pan = ctx.createStereoPanner();
        pan.pan.value = v / (voices - 1) * 2 - 1;
        created.push(pan);
        osc.connect(pan);
        node = pan;
      }
      node.connect(sum);

      osc.start(when);
      osc.stop(when + dur + tail + 0.02);
    }

    /* --- filter --- */
    var tailNode = sum;
    if (state.filter.enabled) {
      var filt = ctx.createBiquadFilter();
      created.push(filt);
      try { filt.type = state.filter.type; } catch (e) { filt.type = 'lowpass'; }
      filt.Q.value = U.clamp(state.filter.q, 0.0001, 40);
      filt.gain.value = 0;
      if (filterCurve) setCurve(filt.frequency, filterCurve, when, dur);
      else filt.frequency.setValueAtTime(cutoff, when);
      sum.connect(filt);
      tailNode = filt;
    }

    /* --- amplitude envelope --- */
    var amp = ctx.createGain();
    created.push(amp);
    if (ampCurve) {
      /* the curve starts at `when`; the oscillator starts there too, so the
         param's intrinsic value can never be heard */
      setCurve(amp.gain, ampCurve, when, dur);
    } else {
      amp.gain.setValueAtTime(1, when);
    }
    /* tiny release so the tail never clicks */
    try { amp.gain.linearRampToValueAtTime(0.0001, when + dur + tail); } catch (e) { /* ignore */ }

    tailNode.connect(amp);
    amp.connect(dest);

    /* --- cleanup --- */
    var lastOsc = created[1] || created[0];
    var cleaned = false;
    var cleanup = function () {
      if (cleaned) return;
      cleaned = true;
      for (var i = 0; i < created.length; i++) { try { created[i].disconnect(); } catch (e) { /* ignore */ } }
      var idx = activeVoices.indexOf(entry);
      if (idx >= 0) activeVoices.splice(idx, 1);
    };
    var entry = { nodes: created, cleanup: cleanup, endsAt: when + dur + tail + 0.05 };
    activeVoices.push(entry);
    if (lastOsc && lastOsc.onended !== undefined) lastOsc.onended = cleanup;
    setTimeout(cleanup, (when - (A.ctx ? A.ctx.currentTime : 0) + dur + tail + 0.4) * 1000);

    return entry;
  };

  /* ------------------------------------------------------------- transport */
  A.schedule = function () {
    if (!A.playing || !A.ctx) return;
    var ctx = A.ctx;
    var state = A.stateProvider();
    var horizon = ctx.currentTime + 0.45;
    var guard = 0;

    while (nextTime < horizon && guard++ < 64) {
      var freq = U.midiToFreq(A.midi);
      A.buildVoice(ctx, A.master, state, nextTime, freq, { pan: state.voice.stereo });
      iteration++;
      nextTime += state.sample.duration;
      if (!A.loop) {
        endTime = nextTime + state.sample.tail;
        break;
      }
    }

    if (!A.loop && endTime && ctx.currentTime >= endTime) A.stop();
  };

  A.play = function (midi, opts) {
    opts = opts || {};
    var ctx = A.ensureCtx();
    if (!ctx) return false;
    A.stopVoices();
    var state = A.stateProvider();
    A.midi = (midi === undefined || midi === null) ? state.note.midi : midi;
    A.loop = opts.loop === undefined ? !!state.transport.loop : !!opts.loop;
    A.playing = true;
    iteration = 0;
    startTime = ctx.currentTime + 0.03;
    nextTime = startTime;
    endTime = 0;
    A.schedule();
    if (timer) clearInterval(timer);
    timer = setInterval(A.schedule, 70);
    A.notify('play');
    return true;
  };

  A.stopVoices = function () {
    for (var i = 0; i < activeVoices.length; i++) {
      var entry = activeVoices[i];
      for (var j = 0; j < entry.nodes.length; j++) {
        var node = entry.nodes[j];
        if (node && typeof node.stop === 'function') {
          try { node.stop(A.ctx ? A.ctx.currentTime : 0); } catch (e) { /* ignore */ }
        }
      }
    }
    var list = activeVoices.slice();
    activeVoices.length = 0;
    setTimeout(function () { list.forEach(function (e) { e.cleanup(); }); }, 60);
  };

  A.stop = function () {
    A.playing = false;
    if (timer) { clearInterval(timer); timer = null; }
    if (A.ctx) A.stopVoices();
    A.notify('stop');
  };

  A.toggleLoop = function (on) {
    A.loop = on;
    if (A.playing && !on) {
      /* let the current pass finish, then stop */
      endTime = nextTime + A.stateProvider().sample.tail;
    }
  };

  /* 0..1 position inside the current pass, for the playhead overlay. */
  A.position = function () {
    if (!A.playing || !A.ctx) return -1;
    var state = A.stateProvider();
    var dur = state.sample.duration;
    var t = A.ctx.currentTime - startTime;
    if (t < 0) return 0;
    if (A.loop) return ((t % dur) + dur) % dur / dur;
    return U.clamp(t / dur, 0, 1);
  };

  A.now = function () { return A.ctx ? A.ctx.currentTime : 0; };

  A.notify = function () { /* replaced by the UI */ };

  /* ------------------------------------------------------------ offline */
  A.postProcess = function (buffer, state) {
    var sr = buffer.sampleRate, len = buffer.length;
    var fadeIn = Math.max(0, Math.min(len - 1, Math.round(state.sample.fadeIn / 1000 * sr)));
    var fadeOut = Math.max(0, Math.min(len - 1, Math.round(state.sample.fadeOut / 1000 * sr)));
    var peak = 0, c, i, d, v;

    for (c = 0; c < buffer.numberOfChannels; c++) {
      d = buffer.getChannelData(c);
      for (i = 0; i < fadeIn; i++) d[i] *= i / fadeIn;
      for (i = 0; i < fadeOut; i++) {
        var idx = len - 1 - i;
        d[idx] *= i / fadeOut;
      }
      for (i = 0; i < len; i++) { v = d[i] < 0 ? -d[i] : d[i]; if (v > peak) peak = v; }
    }

    var gain = 1;
    if (state.sample.normalize && peak > 1e-9) gain = state.sample.peak / peak;
    if (gain !== 1) {
      for (c = 0; c < buffer.numberOfChannels; c++) {
        d = buffer.getChannelData(c);
        for (i = 0; i < len; i++) d[i] *= gain;
      }
    }
    return { peak: peak, gain: gain };
  };

  A.renderOffline = function (state, midi) {
    var OC = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    if (!OC) return Promise.reject(new Error('OfflineAudioContext is not available in this browser.'));
    var sr = state.sample.sampleRate;
    var dur = Math.max(0.005, state.sample.duration);
    var tail = Math.max(0, state.sample.tail);
    var channels = state.sample.mono ? 1 : 2;
    var length = Math.max(1, Math.ceil((dur + tail) * sr));
    var freq = U.midiToFreq(midi === undefined || midi === null ? state.note.midi : midi);

    var oc;
    try {
      oc = new OC(channels, length, sr);
    } catch (e) {
      oc = new OC({ numberOfChannels: channels, length: length, sampleRate: sr });
    }
    A.buildVoice(oc, oc.destination, state, 0, freq, { pan: state.voice.stereo && channels > 1 });
    return oc.startRendering().then(function (buffer) {
      A.postProcess(buffer, state);
      return buffer;
    });
  };

})(typeof window !== 'undefined' ? window : globalThis);
