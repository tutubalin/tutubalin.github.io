/* ==========================================================================
   SampleForge — js/main.js
   Bootstrap: restore a patch from the URL (if any), start the UI, and keep the
   browser from swallowing our shortcuts.
   ========================================================================== */
(function (root) {
  'use strict';

  var SG = (root.SG = root.SG || {});

  function boot() {
    var restored = false;
    try {
      restored = SG.Store.fromHash(root.location ? root.location.hash : '');
    } catch (err) {
      console.warn('[SampleForge] bad patch in URL, starting fresh', err);
    }

    SG.UI.init();

    SG.UI.status(restored
      ? 'Patch restored from the URL.'
      : 'Ready — draw a waveform, stack harmonic rules, shape the envelope, then hit Play.');

    if (restored) SG.UI.toast('Patch loaded from URL', 'ok');

    /* Keep space/arrow keys from scrolling the page while designing. */
    root.addEventListener('keydown', function (ev) {
      var tag = ev.target && ev.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (ev.key === ' ' || ev.key === 'Spacebar') ev.preventDefault();
    });

    /* Warn if a browser feature we need is missing. */
    var missing = [];
    if (!(root.AudioContext || root.webkitAudioContext)) missing.push('Web Audio');
    if (!(root.OfflineAudioContext || root.webkitOfflineAudioContext)) missing.push('OfflineAudioContext');
    if (!root.CanvasRenderingContext2D) missing.push('Canvas 2D');
    if (missing.length) {
      SG.UI.toast('This browser is missing: ' + missing.join(', '), 'err');
      SG.UI.status('Unsupported browser: ' + missing.join(', '), 'err');
    }

    /* Expose a tiny console API for tinkering. */
    SG.api = {
      state: function () { return SG.Store.state; },
      patch: function (p) { return SG.Store.loadPatch(p); },
      json: function () { return SG.Store.toJSON(true); },
      spectrum: function () {
        var s = SG.Store.state;
        return SG.Harmonics.computeSpectrum(s, SG.util.midiToFreq(s.note.midi), s.sample.sampleRate);
      },
      render: function () { return SG.Audio.renderOffline(SG.Store.state, SG.Store.state.note.midi); },
      reset: function () { return SG.Store.reset(); }
    };
    root.SampleForge = SG.api;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})(typeof window !== 'undefined' ? window : globalThis);
