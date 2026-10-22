/* ==========================================================================
   SampleForge — js/keyboard.js
   On-screen piano + computer-keyboard triggering.
   ========================================================================== */
(function (root) {
  'use strict';

  var SG = (root.SG = root.SG || {});
  var U = SG.util;
  var K = (SG.Keyboard = {});

  /* computer keys → semitone offsets from the computer-key base note */
  var KEYMAP = {
    a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
    k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17
  };
  var SPAN = 25;               /* keys drawn on screen */

  K.el = null;
  K.keyNodes = {};
  K.lastPointerMidi = null;
  var bound = false;
  var pointerDown = false;

  K.mount = function (el) {
    K.el = el;
    K.render();
    if (!bound) { bindPointer(); K.bindComputer(); bound = true; }
  };

  K.base = function () { return SG.Store.state.ui.keyRoot || 48; };

  /* The computer-keyboard row starts one octave above the on-screen root. */
  K.computerBase = function () { return K.base() + 12; };

  K.computerLabel = function (midi) {
    var off = midi - K.computerBase();
    for (var key in KEYMAP) if (KEYMAP[key] === off) return key.toUpperCase();
    return '';
  };

  K.render = function () {
    if (!K.el) return;
    var base = K.base();
    var current = SG.Store.state.note.midi;
    K.el.textContent = '';
    K.keyNodes = {};

    for (var i = 0; i < SPAN; i++) {
      var midi = base + i;
      var black = U.isBlackKey(midi);
      var label = midi % 12 === 0 ? U.noteName(midi) : K.computerLabel(midi);
      var key = U.el('div', {
        class: 'key' + (black ? ' key--black' : '') + (midi === current ? ' is-current' : ''),
        'data-midi': String(midi),
        title: U.noteName(midi) + ' · ' + U.fmt.hz(U.midiToFreq(midi))
      }, label ? [U.el('span', { class: 'key__label', text: label })] : []);
      K.el.appendChild(key);
      K.keyNodes[midi] = key;
    }
  };

  function keyFromEvent(ev) {
    var node = ev.target;
    while (node && node !== K.el && !(node.classList && node.classList.contains('key'))) node = node.parentNode;
    if (!node || node === K.el) return null;
    return parseInt(node.getAttribute('data-midi'), 10);
  }

  function bindPointer() {
    K.el.addEventListener('pointerdown', function (ev) {
      var midi = keyFromEvent(ev);
      if (midi === null || !isFinite(midi)) return;
      pointerDown = true;
      K.lastPointerMidi = midi;
      try { K.el.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      K.trigger(midi);
      ev.preventDefault();
    });
    K.el.addEventListener('pointermove', function (ev) {
      if (!pointerDown) return;
      var midi = keyFromEvent(ev);
      if (midi === null || !isFinite(midi) || midi === K.lastPointerMidi) return;
      K.lastPointerMidi = midi;
      K.trigger(midi);
    });
    function release() { pointerDown = false; K.lastPointerMidi = null; }
    K.el.addEventListener('pointerup', release);
    K.el.addEventListener('pointercancel', release);
    K.el.addEventListener('pointerleave', release);
  }

  K.trigger = function (midi) {
    if (!isFinite(midi)) return;
    if (SG.UI && SG.UI.triggerNote) SG.UI.triggerNote(midi);
    K.flash(midi);
  };

  K.flash = function (midi) {
    var node = K.keyNodes[midi];
    if (!node) return;
    node.classList.add('is-down');
    var dur = U.clamp(SG.Store.state.sample.duration * 600, 90, 280);
    setTimeout(function () { node.classList.remove('is-down'); }, dur);
  };

  /* follow = true (default) lets the keyboard slide to the played note.
     Pass false when the user moved the keyboard itself, or the octave shift
     would immediately snap back. */
  K.markCurrent = function (midi, follow) {
    var found = false;
    for (var k in K.keyNodes) {
      var isIt = parseInt(k, 10) === midi;
      K.keyNodes[k].classList.toggle('is-current', isIt);
      if (isIt) found = true;
    }
    if (!found && follow !== false && K.el) {
      var root = Math.floor(midi / 12) * 12 - 12;
      SG.Store.setUI(function (ui) { ui.keyRoot = U.clamp(root, 12, 96); });
      K.render();
      K.markCurrent(midi, false);
    }
  };

  K.octave = function (delta) {
    var base = U.clamp(K.base() + delta * 12, 12, 96);
    SG.Store.setUI(function (ui) { ui.keyRoot = base; });
    K.render();
    K.markCurrent(SG.Store.state.note.midi, false);
  };

  function isTypingTarget(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  K.bindComputer = function () {
    root.addEventListener('keydown', function (ev) {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (isTypingTarget(ev.target)) return;
      if (ev.repeat) { ev.preventDefault(); return; }

      var key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key.toLowerCase();

      if (key === 'z') { K.octave(-1); ev.preventDefault(); return; }
      if (key === 'x') { K.octave(1); ev.preventDefault(); return; }
      if (key === ' ') { if (SG.UI && SG.UI.togglePlay) SG.UI.togglePlay(); ev.preventDefault(); return; }
      if (key === 'escape') { SG.Audio.stop(); ev.preventDefault(); return; }
      if (key === 'l') { if (SG.UI && SG.UI.toggleLoop) SG.UI.toggleLoop(); ev.preventDefault(); return; }

      if (Object.prototype.hasOwnProperty.call(KEYMAP, key)) {
        var midi = K.computerBase() + KEYMAP[key];
        if (midi >= 0 && midi <= 127) { K.trigger(midi); ev.preventDefault(); }
      }
    });
  };

})(typeof window !== 'undefined' ? window : globalThis);
