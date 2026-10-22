/* ==========================================================================
   SampleForge — js/ui.js
   All DOM wiring: controls, rule stack, panels, transport, preview render and
   export. Editors stay dumb; this module owns the state ⇄ DOM synchronisation.
   ========================================================================== */
(function (root) {
  'use strict';

  var SG = (root.SG = root.SG || {});
  var U = SG.util;
  var E = SG.Envelope;
  var H = SG.Harmonics;
  var UI = (SG.UI = {});

  var $ = U.$;
  var bindings = [];
  var lastRuleSig = '';
  var previewToken = 0;
  var previewBuffer = null;
  var previewStats = null;
  var previewMidi = 60;
  var toastTimer = 0;
  var rafId = 0;
  var unlocked = false;

  /* ======================================================================= */
  /*  control binding helpers                                                */
  /* ======================================================================= */

  /* bind(el, {read, apply, parse, out, format, gesture})
     `read`   → value from state that the control should show
     `apply`  → mutates the state (called inside a transient update)
     Gestures are grouped so one drag = one undo step. */
  function bind(el, opts) {
    if (!el) return null;
    var inGesture = false;
    var b = {
      el: el,
      read: opts.read,
      apply: opts.apply,
      parse: opts.parse || function (v) { return v; },
      out: opts.out ? $(opts.out) : null,
      format: opts.format || function (v) { return String(v); },
      type: opts.type || 'value',
      uiOnly: !!opts.uiOnly,
      onChange: opts.onChange || null
    };

    function begin() { if (!inGesture) { inGesture = true; SG.Store.beginGesture(); } }
    function end() { if (inGesture) { inGesture = false; SG.Store.endGesture(); } }

    function commit(fromChangeEvent) {
      var raw = b.type === 'checked' ? el.checked : el.value;
      var value = b.parse(raw);
      begin();
      if (b.uiOnly) SG.Store.setUI(function (ui) { b.apply(value, ui); });
      else SG.Store.updateTransient(function (s) { b.apply(value, s); });
      syncOut(b);
      if (b.onChange) b.onChange(value);
      if (fromChangeEvent) end();
    }

    el.addEventListener('pointerdown', begin);
    el.addEventListener('focus', begin);
    el.addEventListener('keydown', function (ev) { if (ev.key !== 'Tab') begin(); });
    el.addEventListener('input', function () { commit(false); });
    el.addEventListener('change', function () { commit(true); });
    el.addEventListener('blur', end);

    bindings.push(b);
    return b;
  }

  function syncOut(b) {
    if (!b.out) return;
    var v;
    try { v = b.read(SG.Store.state); } catch (e) { return; }
    b.out.textContent = b.format(v, SG.Store.state);
  }

  UI.syncControls = function () {
    for (var i = 0; i < bindings.length; i++) {
      var b = bindings[i];
      var v;
      try { v = b.read(SG.Store.state); } catch (e) { continue; }
      if (document.activeElement !== b.el) {
        if (b.type === 'checked') b.el.checked = !!v;
        else if (b.el.value !== String(v)) b.el.value = v;
      }
      syncOut(b);
    }
  };

  /* ======================================================================= */
  /*  status / toast                                                         */
  /* ======================================================================= */

  UI.status = function (msg, kind) {
    var el = $('#status-text');
    if (!el) return;
    el.textContent = msg;
    el.style.color = kind === 'err' ? '#ff9d9d' : (kind === 'warn' ? '#ffd9a0' : '');
  };

  UI.toast = function (msg, kind) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast is-on' + (kind ? ' is-' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 2600);
  };

  /* ======================================================================= */
  /*  init                                                                   */
  /* ======================================================================= */

  UI.init = function () {
    buildNoteSelect();
    buildPresetSelect();
    buildWavePresets();
    buildEnvPanel();
    buildExprRef();

    UI.waveEditor = new SG.WaveformEditor($('#cv-wave'));
    UI.harmEditor = new SG.HarmonicEditor($('#cv-harm'));
    UI.envEditor = new SG.EnvelopeEditor($('#cv-env'));
    UI.outCanvas = $('#cv-out');
    UI.outCtx = null;

    bindTopbar();
    bindWavePanel();
    bindHarmPanel();
    bindEnvPanelEvents();
    bindVoicePanel();
    bindOutputPanel();
    bindGlobalKeys();

    SG.Keyboard.mount($('#keyboard'));

    SG.Store.subscribe(onStoreChange);
    SG.Audio.notify = function (what) {
      if (what === 'play') { UI.status('Playing ' + U.noteName(SG.Audio.midi) + ' · ' + U.fmt.hz(U.midiToFreq(SG.Audio.midi))); }
      if (what === 'stop') { UI.status('Stopped'); }
      syncTransport();
    };

    /* unlock audio on the first gesture anywhere */
    root.addEventListener('pointerdown', unlockAudio, { once: false });
    root.addEventListener('keydown', unlockAudio, { once: false });

    UI.syncControls();
    renderRules();
    UI.syncEnvInspector();
    syncTransport();
    onStoreChange('init');
    requestPreview();
    tick();
  };

  function unlockAudio() {
    if (unlocked) return;
    unlocked = true;
    root.removeEventListener('pointerdown', unlockAudio);
    root.removeEventListener('keydown', unlockAudio);
    var ctx = SG.Audio.ensureCtx();
    if (ctx) {
      $('#status-engine').textContent = 'audio: ' + (ctx.sampleRate / 1000).toFixed(1) + ' kHz';
      $('#status-ctx').textContent = ctx.state;
    } else {
      $('#status-engine').textContent = 'audio: unavailable';
      UI.toast(SG.Audio.error || 'Web Audio unavailable', 'err');
    }
  }

  /* ======================================================================= */
  /*  top bar                                                                */
  /* ======================================================================= */

  function buildNoteSelect() {
    var sel = $('#sel-note');
    if (!sel) return;
    for (var oct = 1; oct <= 7; oct++) {
      var group = U.el('optgroup', { label: 'Octave ' + oct });
      for (var i = 0; i < 12; i++) {
        var midi = oct * 12 + i;
        if (midi < 12 || midi > 108) continue;
        group.appendChild(U.el('option', {
          value: String(midi),
          text: U.noteName(midi) + '  ·  ' + U.fmt.hz(U.midiToFreq(midi))
        }));
      }
      sel.appendChild(group);
    }
  }

  function buildPresetSelect() {
    var sel = $('#sel-preset');
    if (!sel) return;
    sel.appendChild(U.el('option', { value: '', text: '⚙ Presets…' }));
    var groups = {};
    SG.Presets.PATCHES.forEach(function (p) {
      (groups[p.group || 'Other'] = groups[p.group || 'Other'] || []).push(p);
    });
    Object.keys(groups).forEach(function (g) {
      var og = U.el('optgroup', { label: g });
      groups[g].forEach(function (p) { og.appendChild(U.el('option', { value: p.id, text: p.name })); });
      sel.appendChild(og);
    });
  }

  function buildWavePresets() {
    var box = $('#wave-presets');
    if (!box) return;
    SG.Presets.WAVEFORMS.forEach(function (wp) {
      var btn = U.el('button', { class: 'btn btn--sm', text: wp.label, title: wp.patch.harmonics.rules[0].amp });
      btn.addEventListener('click', function () { applyWavePreset(wp); });
      box.appendChild(btn);
    });
  }

  function applyWavePreset(wp) {
    SG.Store.update(function (s) {
      var p = wp.patch.harmonics;
      if (p.count) s.harmonics.count = p.count;
      if (p.phaseBase) s.harmonics.phaseBase = p.phaseBase;
      s.harmonics.rules = U.deepClone(p.rules);
      s.harmonics.overrides = { amp: [], phase: [] };
      s.harmonics.drawn = false;
    });
    UI.status('Waveform “' + wp.label + '” loaded into the rule stack');
    if (UI.waveEditor) { UI.waveEditor.live = null; UI.waveEditor.lineStart = null; }
    SG.Keyboard.trigger(SG.Store.state.note.midi);
  }

  function bindTopbar() {
    var playBtn = $('#btn-play'), stopBtn = $('#btn-stop'), loopBtn = $('#btn-loop');

    playBtn.addEventListener('click', function () { UI.togglePlay(); });
    stopBtn.addEventListener('click', function () { SG.Audio.stop(); });
    loopBtn.addEventListener('click', function () { UI.toggleLoop(); });

    bind($('#sel-note'), {
      read: function (s) { return s.note.midi; },
      apply: function (v, s) { s.note.midi = U.clamp(v | 0, 0, 127); },
      parse: function (v) { return parseInt(v, 10); },
      onChange: function (v) {
        SG.Keyboard.markCurrent(v);
        SG.Keyboard.trigger(v);
      }
    });

    $('#sel-preset').addEventListener('change', function (ev) {
      var id = ev.target.value;
      var preset = SG.Presets.byId(id);
      if (!preset) return;
      var patch = U.mergeDeep(SG.Store.defaults(), U.deepClone(preset.patch));
      patch.ui = SG.Store.state.ui;
      patch.name = preset.name;
      SG.Store.loadPatch(patch);
      UI.toast('Preset loaded: ' + preset.name, 'ok');
      UI.status('Preset “' + preset.name + '”');
      if (UI.waveEditor) { UI.waveEditor.live = null; UI.waveEditor.lineStart = null; }
      SG.Keyboard.markCurrent(SG.Store.state.note.midi);
      SG.Keyboard.trigger(SG.Store.state.note.midi);
      ev.target.value = id;
    });

    $('#btn-undo').addEventListener('click', function () { UI.undo(); });
    $('#btn-redo').addEventListener('click', function () { UI.redo(); });
    $('#btn-save').addEventListener('click', function () { UI.saveJSON(); });
    $('#btn-load').addEventListener('click', function () { $('#file-input').click(); });
    $('#file-input').addEventListener('change', function (ev) { UI.loadJSON(ev.target.files[0]); ev.target.value = ''; });
    $('#btn-link').addEventListener('click', function () { UI.copyLink(); });
    $('#btn-export').addEventListener('click', function () { UI.exportWav(); });
    $('#btn-export-2').addEventListener('click', function () { UI.exportWav(); });
  }

  UI.undo = function () {
    if (SG.Store.undo()) { UI.status('Undo'); } else { UI.status('Nothing to undo', 'warn'); }
  };
  UI.redo = function () {
    if (SG.Store.redo()) { UI.status('Redo'); } else { UI.status('Nothing to redo', 'warn'); }
  };

  UI.togglePlay = function () {
    if (SG.Audio.playing) { SG.Audio.stop(); return; }
    SG.Audio.play(SG.Store.state.note.midi, { loop: SG.Store.state.transport.loop });
  };

  UI.toggleLoop = function (force) {
    var on = force === undefined ? !SG.Store.state.transport.loop : !!force;
    SG.Store.update(function (s) { s.transport.loop = on; }, { undo: false });
    SG.Audio.toggleLoop(on);
    syncTransport();
  };

  function syncTransport() {
    var playing = SG.Audio.playing;
    var loop = SG.Store.state.transport.loop;
    var playBtn = $('#btn-play'), loopBtn = $('#btn-loop');
    if (playBtn) {
      playBtn.classList.toggle('is-on', playing);
      playBtn.querySelector('span').textContent = playing ? 'Playing' : 'Play';
    }
    if (loopBtn) {
      loopBtn.classList.toggle('is-on', !!loop);
      loopBtn.setAttribute('aria-pressed', loop ? 'true' : 'false');
    }
    var ctxEl = $('#status-ctx');
    if (ctxEl && SG.Audio.ctx) {
      ctxEl.textContent = SG.Audio.ctx.state + (playing ? ' · ' + (loop ? 'looping' : 'one-shot') : '');
    }
  }

  UI.triggerNote = function (midi) {
    unlockAudio();
    SG.Store.updateTransient(function (s) { s.note.midi = midi; });
    SG.Keyboard.markCurrent(midi);
    SG.Audio.play(midi, { loop: SG.Store.state.transport.loop });
    var sel = $('#sel-note');
    if (sel && document.activeElement !== sel) sel.value = String(midi);
    var ro = $('#note-readout');
    if (ro) ro.textContent = U.noteName(midi) + ' · ' + U.fmt.hz(U.midiToFreq(midi));
    requestPreview();
  };

  /* ======================================================================= */
  /*  waveform panel                                                         */
  /* ======================================================================= */

  function bindWavePanel() {
    var toolBox = $('#wave-tools');
    U.$$('.btn', toolBox).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tool = btn.getAttribute('data-tool');
        SG.Store.setUI(function (ui) { ui.waveTool = tool; });
        U.$$('.btn', toolBox).forEach(function (b) { b.classList.toggle('is-on', b === btn); });
        if (UI.waveEditor) { UI.waveEditor.live = null; UI.waveEditor.lineStart = null; UI.waveEditor.linePreview = null; }
      });
    });

    var mirror = $('#btn-mirror');
    mirror.addEventListener('click', function () {
      var on = !SG.Store.state.ui.mirror;
      SG.Store.setUI(function (ui) { ui.mirror = on; });
      mirror.classList.toggle('is-on', on);
      mirror.setAttribute('aria-pressed', on ? 'true' : 'false');
    });

    function op(fn, label) { return function () { if (UI.waveEditor) UI.waveEditor.applyOp(fn, label); }; }
    $('#btn-w-smooth').addEventListener('click', op(function (w) { return H.WaveOps.smooth(w, 2); }, 'Smoothed'));
    $('#btn-w-invert').addEventListener('click', op(H.WaveOps.invert, 'Polarity inverted'));
    $('#btn-w-flip').addEventListener('click', op(H.WaveOps.flip, 'Flipped in time'));
    $('#btn-w-dc').addEventListener('click', op(H.WaveOps.removeDC, 'DC offset removed'));
    $('#btn-w-norm').addEventListener('click', op(H.WaveOps.normalize, 'Scaled to peak 1'));
    $('#btn-w-clear').addEventListener('click', function () { if (UI.waveEditor) UI.waveEditor.clearDraw(); });
  }

  /* ======================================================================= */
  /*  harmonics panel                                                        */
  /* ======================================================================= */

  function bindHarmPanel() {
    bind($('#rng-count'), {
      read: function (s) { return s.harmonics.count; },
      apply: function (v, s) { s.harmonics.count = U.clamp(v | 0, 2, 128); },
      parse: function (v) { return parseInt(v, 10); },
      out: '#out-count',
      format: function (v) { return v + ' harm'; }
    });

    bind($('#sel-normalize'), {
      read: function (s) { return s.harmonics.normalize; },
      apply: function (v, s) { s.harmonics.normalize = v; }
    });

    bind($('#sel-phasebase'), {
      read: function (s) { return s.harmonics.phaseBase; },
      apply: function (v, s) { s.harmonics.phaseBase = v; }
    });

    bind($('#num-seed'), {
      read: function (s) { return s.harmonics.seed; },
      apply: function (v, s) { s.harmonics.seed = Math.round(v) | 0; },
      parse: function (v) { return parseFloat(v) || 0; }
    });

    bind($('#chk-aa'), {
      type: 'checked',
      read: function (s) { return s.harmonics.antiAlias; },
      apply: function (v, s) { s.harmonics.antiAlias = !!v; }
    });

    bind($('#chk-phase'), {
      type: 'checked', uiOnly: true,
      read: function (s) { return s.ui.showPhase; },
      apply: function (v, ui) { ui.showPhase = !!v; },
      onChange: function () {
        var tag = $('#harm-phase-tag');
        if (tag) tag.style.display = SG.Store.state.ui.showPhase ? '' : 'none';
      }
    });

    $('#btn-add-rule').addEventListener('click', function () { UI.addRule(); });
    $('#btn-clear-overrides').addEventListener('click', function () { UI.clearOverrides(); });
  }

  UI.addRule = function (expr, mode) {
    SG.Store.update(function (s) {
      s.harmonics.rules.push({
        id: U.uid('rule'), enabled: true,
        amp: expr || 'slope(n, 1)', mode: mode || 'mul', amount: 1, phase: '', phaseMode: 'add'
      });
    });
    UI.status('Rule added');
    renderRules(true);
  };

  UI.removeRule = function (id) {
    SG.Store.update(function (s) {
      s.harmonics.rules = s.harmonics.rules.filter(function (r) { return r.id !== id; });
      if (!s.harmonics.rules.length) {
        s.harmonics.rules.push({ id: U.uid('rule'), enabled: true, amp: '1/n', mode: 'set', amount: 1, phase: '', phaseMode: 'add' });
      }
    });
    renderRules(true);
  };

  UI.duplicateRule = function (id) {
    SG.Store.update(function (s) {
      var i = s.harmonics.rules.findIndex(function (r) { return r.id === id; });
      if (i < 0) return;
      var copy = U.deepClone(s.harmonics.rules[i]);
      copy.id = U.uid('rule');
      s.harmonics.rules.splice(i + 1, 0, copy);
    });
    renderRules(true);
  };

  UI.moveRule = function (id, dir) {
    SG.Store.update(function (s) {
      var rules = s.harmonics.rules;
      var i = rules.findIndex(function (r) { return r.id === id; });
      var j = i + dir;
      if (i < 0 || j < 0 || j >= rules.length) return;
      var tmp = rules[i]; rules[i] = rules[j]; rules[j] = tmp;
    });
    renderRules(true);
  };

  UI.clearOverrides = function () {
    SG.Store.update(function (s) {
      s.harmonics.overrides = { amp: [], phase: [] };
      s.harmonics.drawn = false;
    });
    if (UI.waveEditor) UI.waveEditor.live = null;
    UI.status('Manual harmonic edits cleared');
  };

  function ruleSignature(rules) {
    return rules.map(function (r) { return r.id + ':' + (r.enabled ? 1 : 0) + ':' + r.mode + ':' + (r.phase ? 1 : 0); }).join('|');
  }

  function renderRules(force) {
    var list = $('#rule-list');
    if (!list) return;
    var rules = SG.Store.state.harmonics.rules;
    var sig = ruleSignature(rules);
    if (!force && sig === lastRuleSig && list.childElementCount === rules.length) { syncRuleErrors(); return; }
    lastRuleSig = sig;
    list.textContent = '';
    rules.forEach(function (r, i) { list.appendChild(buildRuleRow(r, i, rules.length)); });
    syncRuleErrors();
  }
  UI.renderRules = renderRules;

  function buildRuleRow(rule, index, total) {
    var row = U.el('div', { class: 'rule' + (rule.enabled ? '' : ' is-off'), 'data-id': rule.id });

    /* --- top line --- */
    var on = U.el('input', { type: 'checkbox', class: 'rule__on', title: 'Enable this rule' });
    on.checked = rule.enabled;
    on.addEventListener('change', function () {
      SG.Store.update(function (s) {
        var r = findRule(s, rule.id); if (r) r.enabled = on.checked;
      });
      row.classList.toggle('is-off', !on.checked);
      lastRuleSig = '';
      renderRules();
    });

    var idx = U.el('code', { class: 'rule__idx', text: String(index + 1), title: 'Evaluated top to bottom' });

    var expr = U.el('input', {
      class: 'rule__expr', type: 'text', spellcheck: 'false', value: rule.amp,
      placeholder: 'amplitude as a function of n, e.g.  odd(n) ? 1/n : 0',
      'aria-label': 'Rule expression'
    });
    attachExprHandlers(expr, rule.id, 'amp');

    var mode = U.el('select', { class: 'rule__mode', title: 'How this rule combines with the rules above' });
    H.MODES.forEach(function (m) {
      mode.appendChild(U.el('option', { value: m, text: m }));
    });
    mode.value = rule.mode;
    mode.addEventListener('change', function () {
      SG.Store.update(function (s) { var r = findRule(s, rule.id); if (r) r.mode = mode.value; });
      lastRuleSig = ''; renderRules();
    });

    var up = iconBtn('↑', 'Move rule up', function () { UI.moveRule(rule.id, -1); }, 'rule__up');
    var down = iconBtn('↓', 'Move rule down', function () { UI.moveRule(rule.id, 1); }, 'rule__down');
    var dup = iconBtn('⧉', 'Duplicate rule', function () { UI.duplicateRule(rule.id); }, 'rule__dup');
    var del = iconBtn('✕', 'Delete rule', function () { UI.removeRule(rule.id); }, 'rule__del');
    del.classList.add('btn--danger');

    var more = iconBtn(rule.phase ? '◧ phase' : '⋯', 'Phase expression & amount', function () {
      sub.style.display = sub.style.display === 'none' ? 'flex' : 'none';
    }, 'rule__more');

    row.appendChild(U.el('div', { class: 'rule__top' }, [on, idx, expr, mode, more, up, down, dup, del]));

    /* --- second line: amount + phase --- */
    var sub = U.el('div', { class: 'rule__sub' });
    sub.style.display = rule.phase ? 'flex' : 'none';

    var amount = U.el('input', { type: 'range', min: '-2', max: '2', step: '0.01', value: String(rule.amount) });
    var amountOut = U.el('output', { text: U.fmt.num(rule.amount, 2) });
    var amountLabel = U.el('label', { class: 'field' }, [document.createTextNode('amount'), amount, amountOut]);
    amount.addEventListener('pointerdown', function () { SG.Store.beginGesture(); });
    amount.addEventListener('focus', function () { SG.Store.beginGesture(); });
    amount.addEventListener('input', function () {
      SG.Store.beginGesture();
      var v = parseFloat(amount.value);
      SG.Store.updateTransient(function (s) { var r = findRule(s, rule.id); if (r) r.amount = isFinite(v) ? v : 1; });
      amountOut.textContent = U.fmt.num(v, 2);
    });
    amount.addEventListener('change', function () { SG.Store.endGesture(); });
    amount.addEventListener('blur', function () { SG.Store.endGesture(); });

    var pexpr = U.el('input', {
      class: 'rule__pexpr', type: 'text', spellcheck: 'false', value: rule.phase || '',
      placeholder: 'phase in turns (1 = 360°), e.g. 0.5*odd(n)', 'aria-label': 'Phase expression'
    });
    attachExprHandlers(pexpr, rule.id, 'phase');

    var pmode = U.el('select', { class: 'rule__mode', title: 'Add to the phase, or replace it' });
    pmode.appendChild(U.el('option', { value: 'add', text: 'add' }));
    pmode.appendChild(U.el('option', { value: 'set', text: 'set' }));
    pmode.value = rule.phaseMode || 'add';
    pmode.addEventListener('change', function () {
      SG.Store.update(function (s) { var r = findRule(s, rule.id); if (r) r.phaseMode = pmode.value; });
      lastRuleSig = ''; renderRules();
    });

    sub.appendChild(amountLabel);
    sub.appendChild(U.el('label', { class: 'field' }, [document.createTextNode('phase'), pexpr, pmode]));
    row.appendChild(sub);
    row.appendChild(U.el('div', { class: 'rule__err', 'data-err-for': rule.id }));
    return row;
  }

  function iconBtn(label, title, fn, cls) {
    var b = U.el('button', { class: 'btn btn--sm btn--icon' + (cls ? ' ' + cls : ''), text: label, title: title, type: 'button' });
    b.addEventListener('click', fn);
    return b;
  }

  function findRule(state, id) {
    var rules = state.harmonics.rules;
    for (var i = 0; i < rules.length; i++) if (rules[i].id === id) return rules[i];
    return null;
  }

  /* Expression inputs: one undo step per editing session, live re-render. */
  function attachExprHandlers(input, id, field) {
    var started = false;
    input.addEventListener('focus', function () { started = true; SG.Store.beginGesture(); });
    input.addEventListener('input', function () {
      if (!started) { started = true; SG.Store.beginGesture(); }
      var v = input.value;
      SG.Store.updateTransient(function (s) {
        var r = findRule(s, id); if (r) r[field] = v;
      });
    });
    function finish() {
      if (!started) return;
      started = false;
      SG.Store.endGesture();
      /* no forced rebuild: the signature check keeps focus where the user put it */
      renderRules();
    }
    input.addEventListener('blur', finish);
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
    });
  }

  function syncRuleErrors() {
    var s = SG.Store.state;
    var sp = H.computeSpectrum(s, U.midiToFreq(s.note.midi), s.sample.sampleRate);
    var rows = U.$$('#rule-list .rule');
    rows.forEach(function (row) {
      var id = row.getAttribute('data-id');
      var errEl = row.querySelector('.rule__err');
      var msgs = sp.errors.filter(function (e) { return e.rule === id; });
      if (msgs.length) {
        row.classList.add('has-error');
        if (errEl) errEl.textContent = msgs.map(function (m) { return m.field + ': ' + m.message; }).join(' · ');
      } else {
        row.classList.remove('has-error');
        if (errEl) errEl.textContent = '';
      }
    });
    var chip = $('#harm-info');
    if (chip && sp.errors.length) chip.className = 'chip chip--mono chip--err';
  }

  function buildExprRef() {
    var box = $('#expr-ref');
    if (!box) return;
    var cols = U.el('div', { class: 'ref__cols' });
    H.DOCS.forEach(function (group) {
      var list = U.el('ul');
      group.items.forEach(function (item) {
        list.appendChild(U.el('li', { html: '<b>' + U.escapeHtml(item[0]) + '</b> <span>' + U.escapeHtml(item[1]) + '</span>' }));
      });
      cols.appendChild(U.el('div', {}, [U.el('h4', { text: group.title }), list]));
    });
    box.appendChild(cols);

    box.appendChild(U.el('h4', { text: 'Click a recipe to load it into rule 1' }));
    var wrap = U.el('div', { class: 'recipe' });
    H.RECIPES.forEach(function (rec) {
      var b = U.el('button', { class: 'btn btn--sm', type: 'button', text: rec.label, title: rec.expr });
      b.addEventListener('click', function () {
        SG.Store.update(function (s) {
          var r = s.harmonics.rules[0] || (s.harmonics.rules[0] = { id: U.uid('rule'), enabled: true, amount: 1, phaseMode: 'add' });
          r.amp = rec.expr;
          r.mode = rec.mode || 'set';
          r.enabled = true;
          if (rec.phase) { r.phase = rec.phase; r.phaseMode = 'set'; }
          /* recipes assume a clean slate */
          s.harmonics.overrides = { amp: [], phase: [] };
          s.harmonics.drawn = false;
        });
        if (UI.waveEditor) UI.waveEditor.live = null;
        lastRuleSig = '';
        renderRules(true);
        UI.status('Recipe: ' + rec.label);
        SG.Keyboard.trigger(SG.Store.state.note.midi);
      });
      wrap.appendChild(b);
    });
    box.appendChild(wrap);
    box.appendChild(U.el('div', {
      class: 'recipe',
      html: '<code>amp = combine(amp, amount × expression(n))</code> — rules run top to bottom, ' +
        'and <b>set</b>/<b>mul</b>/<b>add</b>/<b>max</b>/<b>min</b> decide how each result is folded in.'
    }));
  }

  /* ======================================================================= */
  /*  envelope panel                                                         */
  /* ======================================================================= */

  function buildEnvPanel() {
    var side = $('#env-side');
    if (!side) return;
    side.textContent = '';

    /* inspector */
    var insp = U.el('div', { class: 'env-inspector' });
    insp.appendChild(U.el('span', { class: 'env-inspector__title', text: 'Point' }));

    var tIn = U.el('input', { type: 'number', id: 'env-pt-t', step: '0.1', min: '0' });
    var vIn = U.el('input', { type: 'number', id: 'env-pt-v', step: '0.01' });
    var cIn = U.el('input', { type: 'range', id: 'env-pt-c', min: '-1', max: '1', step: '0.01', value: '0' });
    var cOut = U.el('output', { id: 'env-pt-c-out', text: '0.00' });
    var hold = U.el('input', { type: 'checkbox', id: 'env-pt-hold' });

    insp.appendChild(U.el('label', { class: 'field' }, [document.createTextNode('Time (ms)'), tIn]));
    insp.appendChild(U.el('label', { class: 'field' }, [document.createTextNode('Value'), vIn]));
    insp.appendChild(U.el('label', { class: 'field' }, [document.createTextNode('Curve'),
      U.el('span', { class: 'range-row' }, [cIn, cOut])]));
    insp.appendChild(U.el('label', { class: 'check check--tight' }, [hold, document.createTextNode(' Hold')]));
    var delBtn = U.el('button', { class: 'btn btn--sm btn--danger', type: 'button', text: 'Delete' });
    var zeroBtn = U.el('button', { class: 'btn btn--sm', type: 'button', text: 'Zero' });
    insp.appendChild(U.el('div', { class: 'btn-group' }, [zeroBtn, delBtn]));
    side.appendChild(insp);

    /* modulation options (pitch / filter) */
    var mods = U.el('div', { class: 'env-mods', id: 'env-mods' });
    side.appendChild(mods);

    /* stats */
    side.appendChild(U.el('div', { class: 'meters', id: 'env-stats' }));

    /* --- inspector wiring --- */
    function selected() { return UI.envEditor ? UI.envEditor.selected : -1; }

    function pointUpdate(fn, opts) {
      var key = SG.Store.state.ui.envTab;
      var idx = selected();
      if (idx < 0) return;
      var mutate = function (s) {
        var env = s.envelopes[key];
        var pt = env.points[idx];
        if (pt) fn(pt, s, idx, env);
      };
      if (opts && opts.undo) SG.Store.update(mutate);
      else SG.Store.updateTransient(mutate);
    }

    function gesture(input, handler) {
      var started = false;
      function begin() { if (!started) { started = true; SG.Store.beginGesture(); } }
      function end() { if (started) { started = false; SG.Store.endGesture(); } }
      input.addEventListener('focus', begin);
      input.addEventListener('pointerdown', begin);
      input.addEventListener('keydown', begin);
      input.addEventListener('input', function () { begin(); handler(); });
      input.addEventListener('change', function () { handler(); end(); });
      input.addEventListener('blur', end);
    }

    gesture(tIn, function () {
      var ms = parseFloat(tIn.value);
      if (!isFinite(ms)) return;
      pointUpdate(function (pt, s, idx, env) {
        var dur = s.sample.duration;
        var cfg = SG.Store.ENV_CONFIG[s.ui.envTab];
        E.movePoint(env, idx, U.clamp(ms / 1000 / dur, 0, 1), pt.v, { min: cfg.min, max: cfg.max });
      });
    });
    gesture(vIn, function () {
      var v = parseFloat(vIn.value);
      if (!isFinite(v)) return;
      pointUpdate(function (pt, s, idx, env) {
        var cfg = SG.Store.ENV_CONFIG[s.ui.envTab];
        E.movePoint(env, idx, pt.t, v, { min: cfg.min, max: cfg.max });
      });
    });
    gesture(cIn, function () {
      var c = parseFloat(cIn.value);
      if (!isFinite(c)) return;
      pointUpdate(function (pt) { pt.c = U.clamp(c, -1, 1); });
      cOut.textContent = U.fmt.num(c, 2);
    });
    hold.addEventListener('change', function () {
      pointUpdate(function (pt) { pt.hold = hold.checked; }, { undo: true });
    });
    delBtn.addEventListener('click', function () { if (UI.envEditor) UI.envEditor.deleteSelected(); });
    zeroBtn.addEventListener('click', function () {
      pointUpdate(function (pt, s, idx, env) {
        var cfg = SG.Store.ENV_CONFIG[s.ui.envTab];
        E.movePoint(env, idx, pt.t, cfg.bipolar ? 0 : 0, { min: cfg.min, max: cfg.max });
      }, { undo: true });
    });
  }

  /* Rebuilt only when the destination tab changes. */
  var modsFor = '';
  function buildEnvMods() {
    var st = SG.Store.state;
    var cfg = SG.Store.ENV_CONFIG[st.ui.envTab];
    var mods = $('#env-mods');
    if (!mods || modsFor === cfg.key) { syncEnvMods(); return; }
    modsFor = cfg.key;
    mods.textContent = '';

    var enable = U.el('input', { type: 'checkbox', id: 'env-mod-enable' });
    if (cfg.key === 'amp') { enable.disabled = true; enable.title = 'The amplitude envelope is always on'; }
    enable.addEventListener('change', function () {
      SG.Store.update(function (s) { s.envelopes[cfg.key].enabled = enable.checked; });
    });
    mods.appendChild(U.el('label', { class: 'check' },
      [enable, document.createTextNode(cfg.key === 'amp' ? ' Amplitude envelope (always on)' : ' Modulate ' + cfg.label.toLowerCase())]));

    if (cfg.key !== 'amp') {
      var depth = U.el('input', {
        type: 'range', id: 'env-mod-depth',
        min: String(cfg.depthMin), max: String(cfg.depthMax), step: String(cfg.depthStep)
      });
      var dOut = U.el('output', { id: 'env-mod-depth-out' });
      var started = false;
      function begin() { if (!started) { started = true; SG.Store.beginGesture(); } }
      function end() { if (started) { started = false; SG.Store.endGesture(); } }
      depth.addEventListener('pointerdown', begin);
      depth.addEventListener('focus', begin);
      depth.addEventListener('input', function () {
        begin();
        var v = parseFloat(depth.value);
        SG.Store.updateTransient(function (s) { s.envelopes[cfg.key].depth = v; });
        dOut.textContent = cfg.key === 'pitch' ? U.fmt.num(v, 1) + ' st' : U.fmt.num(v, 1) + ' oct';
      });
      depth.addEventListener('change', end);
      depth.addEventListener('blur', end);
      mods.appendChild(U.el('label', { class: 'field' }, [
        document.createTextNode(cfg.depthLabel),
        U.el('span', { class: 'range-row' }, [depth, dOut])
      ]));
    }
    syncEnvMods();
  }

  function syncEnvMods() {
    var st = SG.Store.state;
    var cfg = SG.Store.ENV_CONFIG[st.ui.envTab];
    var env = st.envelopes[st.ui.envTab];
    var enable = $('#env-mod-enable');
    if (enable && document.activeElement !== enable) enable.checked = !!env.enabled;
    var depth = $('#env-mod-depth');
    if (depth && document.activeElement !== depth) depth.value = String(env.depth);
    var dOut = $('#env-mod-depth-out');
    if (dOut) dOut.textContent = cfg.key === 'pitch' ? U.fmt.num(env.depth, 1) + ' st' : U.fmt.num(env.depth, 1) + ' oct';
  }

  UI.syncEnvInspector = function () {
    var st = SG.Store.state;
    var cfg = SG.Store.ENV_CONFIG[st.ui.envTab];
    var env = st.envelopes[st.ui.envTab];
    var idx = UI.envEditor ? UI.envEditor.selected : -1;
    var tIn = $('#env-pt-t'), vIn = $('#env-pt-v'), cIn = $('#env-pt-c'),
      cOut = $('#env-pt-c-out'), hold = $('#env-pt-hold');
    if (!tIn) return;

    var hasSel = idx >= 0 && idx < env.points.length;
    [tIn, vIn, cIn, hold].forEach(function (el) { el.disabled = !hasSel; });
    U.$$('.env-inspector .btn').forEach(function (b) { b.disabled = !hasSel; });

    if (hasSel) {
      var pt = env.points[idx];
      if (document.activeElement !== tIn) tIn.value = (pt.t * st.sample.duration * 1000).toFixed(1);
      if (document.activeElement !== vIn) vIn.value = pt.v.toFixed(3);
      if (document.activeElement !== cIn) cIn.value = String(pt.c || 0);
      cOut.textContent = pt.hold ? 'hold' : U.fmt.num(pt.c || 0, 2);
      hold.checked = !!pt.hold;
      tIn.max = String(st.sample.duration * 1000);
      vIn.step = cfg.bipolar ? '0.01' : '0.01';
      vIn.min = String(cfg.min); vIn.max = String(cfg.max);
    } else {
      cOut.textContent = '—';
      if (document.activeElement !== tIn) tIn.value = '';
      if (document.activeElement !== vIn) vIn.value = '';
    }

    buildEnvMods();

    /* stats */
    var statsBox = $('#env-stats');
    if (statsBox) {
      var stats = E.stats(env);
      var dur = st.sample.duration;
      var items = [
        cfg.label,
        stats.points + ' points',
        'peak ' + (cfg.describe ? cfg.describe(stats.peak, st) : U.fmt.num(stats.peak, 2)),
        'at ' + U.fmt.ms(stats.peakT * dur),
        'mean ' + U.fmt.num(stats.mean, 3)
      ];
      statsBox.textContent = '';
      items.forEach(function (txt, i) {
        statsBox.appendChild(U.el('span', { class: 'chip' + (i === 0 ? ' chip--mono' : ''), text: txt }));
      });
    }

    buildEnvShapes();

    var tag = $('#env-tag');
    if (tag) tag.textContent = cfg.label.toLowerCase();
  };

  function buildEnvShapes() {
    var box = $('#env-shapes');
    if (!box) return;
    var st = SG.Store.state;
    var cfg = SG.Store.ENV_CONFIG[st.ui.envTab];
    var sig = cfg.key;
    if (box.getAttribute('data-sig') === sig) return;
    box.setAttribute('data-sig', sig);
    box.textContent = '';
    Object.keys(cfg.shapes).forEach(function (key) {
      var b = U.el('button', {
        class: 'btn btn--sm', type: 'button', text: cfg.shapes[key].label,
        title: 'Replace the ' + cfg.label.toLowerCase() + ' envelope with the ' + cfg.shapes[key].label + ' shape'
      });
      b.addEventListener('click', function () {
        SG.Store.update(function (s) {
          E[cfg.shapeFn](s.envelopes[cfg.key], key);
          if (cfg.key !== 'amp') s.envelopes[cfg.key].enabled = true;
        });
        if (UI.envEditor) UI.envEditor.selected = -1;
        UI.status(cfg.label + ' → ' + cfg.shapes[key].label);
      });
      box.appendChild(b);
    });
  }

  function bindEnvPanelEvents() {
    var tabs = $('#env-tabs');
    U.$$('.tab', tabs).forEach(function (tab) {
      tab.addEventListener('click', function () {
        var key = tab.getAttribute('data-env');
        SG.Store.setUI(function (ui) { ui.envTab = key; });
        U.$$('.tab', tabs).forEach(function (x) { x.classList.toggle('is-on', x === tab); });
        if (UI.envEditor) UI.envEditor.selected = -1;
        UI.syncEnvInspector();
        UI.envEditor.requestDraw();
      });
    });

    bind($('#num-duration'), {
      read: function (s) { return s.sample.duration; },
      apply: function (v, s) { s.sample.duration = U.clamp(v, 0.01, 30); },
      parse: function (v) { return parseFloat(v) || 1; },
      onChange: function () { buildEnvShapes(); requestPreview(); }
    });

    var snap = $('#btn-snap');
    snap.addEventListener('click', function () {
      var on = !SG.Store.state.ui.snap;
      SG.Store.setUI(function (ui) { ui.snap = on; });
      snap.classList.toggle('is-on', on);
      snap.setAttribute('aria-pressed', on ? 'true' : 'false');
    });

    $('#btn-env-del').addEventListener('click', function () { if (UI.envEditor) UI.envEditor.deleteSelected(); });
    $('#btn-env-reset').addEventListener('click', function () {
      var key = SG.Store.state.ui.envTab;
      SG.Store.update(function (s) {
        s.envelopes[key] = U.deepClone(SG.Store.defaults().envelopes[key]);
      });
      if (UI.envEditor) UI.envEditor.selected = -1;
      UI.status('Envelope reset');
    });
  }

  /* ======================================================================= */
  /*  voice + render panel                                                   */
  /* ======================================================================= */

  function cutoffToSlider(f) { return Math.log2(U.clamp(f, 20, 20000) / 20) / Math.log2(1000); }
  function sliderToCutoff(v) { return 20 * Math.pow(1000, U.clamp(v, 0, 1)); }

  function bindVoicePanel() {
    bind($('#rng-volume'), {
      read: function (s) { return s.transport.volume; },
      apply: function (v, s) { s.transport.volume = U.clamp(v, 0, 1); },
      parse: parseFloat,
      out: '#out-volume', format: function (v) { return U.fmt.num(v, 2); },
      onChange: function (v) { SG.Audio.ensureCtx(); SG.Audio.setVolume(v); }
    });

    bind($('#rng-unison'), {
      read: function (s) { return s.voice.unison; },
      apply: function (v, s) { s.voice.unison = U.clamp(v | 0, 1, 5); },
      parse: function (v) { return parseInt(v, 10); },
      out: '#out-unison', format: function (v) { return v + (v > 1 ? ' voices' : ' voice'); }
    });

    bind($('#rng-spread'), {
      read: function (s) { return s.voice.spread; },
      apply: function (v, s) { s.voice.spread = U.clamp(v, 0, 200); },
      parse: parseFloat,
      out: '#out-spread', format: function (v) { return '±' + U.fmt.num(v / 2, 1) + '¢'; }
    });

    bind($('#chk-stereo'), {
      type: 'checked',
      read: function (s) { return s.voice.stereo; },
      apply: function (v, s) { s.voice.stereo = !!v; }
    });

    bind($('#chk-trim'), {
      type: 'checked',
      read: function (s) { return s.voice.autoTrim; },
      apply: function (v, s) { s.voice.autoTrim = !!v; }
    });

    bind($('#chk-filter'), {
      type: 'checked',
      read: function (s) { return s.filter.enabled; },
      apply: function (v, s) { s.filter.enabled = !!v; }
    });

    bind($('#sel-filter-type'), {
      read: function (s) { return s.filter.type; },
      apply: function (v, s) { s.filter.type = v; }
    });

    bind($('#rng-q'), {
      read: function (s) { return s.filter.q; },
      apply: function (v, s) { s.filter.q = U.clamp(v, 0.01, 40); },
      parse: parseFloat,
      out: '#out-q', format: function (v) { return U.fmt.num(v, 1); }
    });

    bind($('#rng-cutoff'), {
      read: function (s) { return cutoffToSlider(s.filter.cutoff).toFixed(4); },
      apply: function (v, s) { s.filter.cutoff = Math.round(sliderToCutoff(v)); },
      parse: parseFloat,
      out: '#out-cutoff',
      format: function (v, s) { return U.fmt.hz(s.filter.cutoff); }
    });

    bind($('#sel-samplerate'), {
      read: function (s) { return s.sample.sampleRate; },
      apply: function (v, s) { s.sample.sampleRate = v; },
      parse: function (v) { return parseInt(v, 10); }
    });

    bind($('#sel-bitdepth'), {
      read: function (s) { return s.sample.bitDepth; },
      apply: function (v, s) { s.sample.bitDepth = v; },
      parse: function (v) { return parseInt(v, 10); }
    });

    bind($('#txt-filename'), {
      read: function (s) { return s.sample.filename; },
      apply: function (v, s) { s.sample.filename = String(v).slice(0, 80); }
    });

    bind($('#chk-mono'), {
      type: 'checked',
      read: function (s) { return s.sample.mono; },
      apply: function (v, s) { s.sample.mono = !!v; }
    });

    bind($('#chk-normalize-out'), {
      type: 'checked',
      read: function (s) { return s.sample.normalize; },
      apply: function (v, s) { s.sample.normalize = !!v; }
    });

    bind($('#rng-peak'), {
      read: function (s) { return s.sample.peak; },
      apply: function (v, s) { s.sample.peak = U.clamp(v, 0.05, 1); },
      parse: parseFloat,
      out: '#out-peak', format: function (v) { return U.fmt.num(v, 2) + ' / ' + U.fmt.db(v); }
    });

    bind($('#num-fadein'), {
      read: function (s) { return s.sample.fadeIn; },
      apply: function (v, s) { s.sample.fadeIn = U.clamp(v, 0, 500); },
      parse: parseFloat
    });

    bind($('#num-fadeout'), {
      read: function (s) { return s.sample.fadeOut; },
      apply: function (v, s) { s.sample.fadeOut = U.clamp(v, 0, 2000); },
      parse: parseFloat
    });
  }

  /* ======================================================================= */
  /*  output preview                                                         */
  /* ======================================================================= */

  function bindOutputPanel() {
    /* the preview re-renders whenever the patch changes (debounced) */
  }

  var requestPreview = U.debounce(function () {
    var s = SG.Store.state;
    previewMidi = s.note.midi;
    var token = ++previewToken;
    var t0 = root.performance ? performance.now() : Date.now();
    SG.Audio.renderOffline(U.deepClone(s), previewMidi).then(function (buffer) {
      if (token !== previewToken) return;
      previewBuffer = buffer;
      previewStats = SG.Wav.stats(buffer);
      peakCache.cols = 0;
      var t1 = root.performance ? performance.now() : Date.now();
      syncOutputMeter(t1 - t0);
      drawOutput();
    }).catch(function (err) {
      if (token !== previewToken) return;
      console.warn('[SampleForge] preview render failed', err);
      UI.status('Preview render failed: ' + (err && err.message ? err.message : err), 'err');
    });
  }, 220);
  UI.requestPreview = requestPreview;

  function syncOutputMeter(renderMs) {
    var box = $('#out-meters');
    if (!box || !previewStats) return;
    var st = previewStats;
    box.textContent = '';
    var items = [
      U.fmt.ms(st.duration),
      st.frames + ' frames',
      (st.sampleRate / 1000) + ' kHz',
      st.channels === 1 ? 'mono' : 'stereo',
      'peak ' + U.fmt.db(st.peak),
      'rms ' + U.fmt.db(st.rms),
      'dc ' + U.fmt.num(st.dc, 4),
      'render ' + renderMs.toFixed(0) + ' ms'
    ];
    items.forEach(function (txt) {
      box.appendChild(U.el('span', {
        class: 'chip chip--mono' + (txt.indexOf('peak') === 0 && st.peak > 0.999 ? ' chip--err' : ''),
        text: txt
      }));
    });
    if (st.clipped > 0) {
      box.appendChild(U.el('span', { class: 'chip chip--err', text: st.clipped + ' clipped' }));
    }
    var rs = $('#render-status');
    if (rs) rs.textContent = 'Offline render took ' + renderMs.toFixed(0) + ' ms.';
  }

  /* Peak cache so the playhead animation doesn't rescan the buffer every frame. */
  var peakCache = { cols: 0, min: null, max: null };

  function computePeaks(cols) {
    if (!previewBuffer) { peakCache.cols = 0; return null; }
    if (peakCache.cols === cols && peakCache.min) return peakCache;
    var data = previewBuffer.getChannelData(0);
    var frames = data.length;
    var mn = new Float32Array(cols), mx = new Float32Array(cols);
    var per = frames / cols;
    for (var c = 0; c < cols; c++) {
      var i0 = Math.floor(c * per), i1 = Math.min(frames, Math.max(i0 + 1, Math.floor((c + 1) * per)));
      var lo = 0, hi = 0;
      for (var i = i0; i < i1; i++) {
        var v = data[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      mn[c] = lo; mx[c] = hi;
    }
    peakCache = { cols: cols, min: mn, max: mx };
    return peakCache;
  }

  function drawOutput() {
    var canvas = UI.outCanvas;
    if (!canvas) return;
    var fit = U.fitCanvas(canvas);
    var ctx = fit.ctx, w = fit.w, h = fit.h;
    var t = SG.Theme.get();
    ctx.clearRect(0, 0, w, h);

    var padL = 10, padR = 10, padT = 10, padB = 16;
    var p = { x: padL, y: padT, w: Math.max(10, w - padL - padR), h: Math.max(10, h - padT - padB) };
    var mid = p.y + p.h / 2;

    /* frame + grid */
    ctx.save();
    ctx.strokeStyle = SG.rgba(t.line, 0.9);
    ctx.lineWidth = 1;
    for (var g = 0; g <= 8; g++) {
      var x = Math.round(p.x + p.w * g / 8) + 0.5;
      ctx.strokeStyle = SG.rgba(t.line, g % 2 === 0 ? 0.9 : 0.45);
      ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke();
    }
    ctx.strokeStyle = SG.rgba(t.text3, 0.4);
    ctx.beginPath(); ctx.moveTo(p.x, Math.round(mid) + 0.5); ctx.lineTo(p.x + p.w, Math.round(mid) + 0.5); ctx.stroke();
    ctx.restore();

    if (!previewBuffer) {
      ctx.fillStyle = SG.rgba(t.text3, 0.8);
      ctx.font = t.font;
      ctx.textAlign = 'center';
      ctx.fillText('rendering…', p.x + p.w / 2, mid);
      return;
    }

    var cols = Math.max(1, Math.floor(p.w));
    var peaks = computePeaks(cols);
    if (!peaks) return;

    ctx.save();
    var grad = ctx.createLinearGradient(0, p.y, 0, p.y + p.h);
    grad.addColorStop(0, SG.rgba(t.out, 0.95));
    grad.addColorStop(0.5, SG.rgba(t.out, 0.55));
    grad.addColorStop(1, SG.rgba(t.out, 0.95));
    ctx.fillStyle = grad;
    var scale = p.h / 2 - 1;
    for (var c = 0; c < cols; c++) {
      var y0 = mid - peaks.max[c] * scale;
      var y1 = mid - peaks.min[c] * scale;
      ctx.fillRect(p.x + c, y0, 1, Math.max(1, y1 - y0));
    }
    ctx.restore();

    /* envelope outline of the render window */
    var pos = SG.Audio.position();
    if (pos >= 0) {
      var px = p.x + pos * p.w;
      ctx.save();
      ctx.strokeStyle = SG.rgba(t.text, 0.75);
      ctx.beginPath(); ctx.moveTo(px + 0.5, p.y); ctx.lineTo(px + 0.5, p.y + p.h); ctx.stroke();
      ctx.restore();
    }

    /* time labels */
    var dur = previewBuffer.duration;
    ctx.save();
    ctx.font = t.fontSm;
    ctx.fillStyle = SG.rgba(t.text3, 0.85);
    for (var q = 0; q <= 4; q++) {
      var xx = p.x + p.w * q / 4;
      var label = U.fmt.ms(dur * q / 4);
      ctx.textAlign = q === 0 ? 'left' : (q === 4 ? 'right' : 'center');
      ctx.fillText(label, xx, p.y + p.h + 12);
    }
    ctx.restore();

    var tag = $('#out-tag');
    if (tag) {
      tag.textContent = (previewBuffer.numberOfChannels === 1 ? 'mono' : 'stereo') + ' · ' +
        (previewBuffer.sampleRate / 1000) + ' kHz · ' + SG.Store.state.sample.bitDepth + '-bit · ' +
        U.fmt.ms(previewBuffer.duration);
    }
  }
  UI.drawOutput = drawOutput;

  /* ======================================================================= */
  /*  export / save / load / link                                            */
  /* ======================================================================= */

  UI.exportWav = function () {
    var s = SG.Store.state;
    var btn = $('#btn-export'), btn2 = $('#btn-export-2');
    [btn, btn2].forEach(function (b) { if (b) { b.disabled = true; b.classList.add('is-busy'); } });
    UI.status('Rendering ' + U.fmt.ms(s.sample.duration) + ' at ' + s.sample.sampleRate + ' Hz…');

    SG.Audio.renderOffline(U.deepClone(s), s.note.midi).then(function (buffer) {
      var blob = SG.Wav.encode(buffer, s.sample.bitDepth);
      var name = (s.sample.filename || 'sample').replace(/[^\w\-. ]+/g, '_');
      var filename = U.noteName(s.note.midi) + '-' + name + '-' + s.sample.sampleRate + '-' + s.sample.bitDepth + 'bit.wav';
      U.downloadBlob(blob, filename);
      var st = SG.Wav.stats(buffer);
      UI.toast('Exported ' + filename + ' · ' + (blob.size / 1024).toFixed(1) + ' kB · peak ' + U.fmt.db(st.peak), 'ok');
      UI.status('Exported ' + filename);
    }).catch(function (err) {
      UI.toast('Export failed: ' + (err && err.message ? err.message : err), 'err');
      UI.status('Export failed', 'err');
    }).then(function () {
      [btn, btn2].forEach(function (b) { if (b) { b.disabled = false; b.classList.remove('is-busy'); } });
    });
  };

  UI.saveJSON = function () {
    var s = SG.Store.state;
    var blob = new Blob([SG.Store.toJSON(true)], { type: 'application/json' });
    var name = (s.sample.filename || 'sample').replace(/[^\w\-. ]+/g, '_') + '.sampleforge.json';
    U.downloadBlob(blob, name);
    UI.toast('Patch saved as ' + name, 'ok');
  };

  UI.loadJSON = function (file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        SG.Store.fromJSON(String(reader.result));
        UI.toast('Patch loaded from ' + file.name, 'ok');
        UI.status('Loaded ' + file.name);
        if (UI.waveEditor) UI.waveEditor.live = null;
        lastRuleSig = '';
        SG.Keyboard.markCurrent(SG.Store.state.note.midi);
        SG.Keyboard.trigger(SG.Store.state.note.midi);
      } catch (err) {
        UI.toast('Could not read that file: ' + err.message, 'err');
      }
    };
    reader.onerror = function () { UI.toast('Could not read that file', 'err'); };
    reader.readAsText(file);
  };

  UI.copyLink = function () {
    SG.Store.writeHash();
    var url = root.location.href.split('#')[0] + SG.Store.toHash();
    function fallback() {
      root.prompt('Copy the patch URL:', url);
    }
    if (root.navigator && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () {
        UI.toast('Patch URL copied to the clipboard (' + (url.length / 1024).toFixed(1) + ' kB)', 'ok');
      }, fallback);
    } else fallback();
  };

  /* ======================================================================= */
  /*  global keys + store reactions                                          */
  /* ======================================================================= */

  function bindGlobalKeys() {
    root.addEventListener('keydown', function (ev) {
      var mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.key.toLowerCase() === 'z') {
        ev.preventDefault();
        if (ev.shiftKey) UI.redo(); else UI.undo();
        return;
      }
      if (mod && ev.key.toLowerCase() === 'y') { ev.preventDefault(); UI.redo(); return; }
      if (mod && ev.key.toLowerCase() === 's') { ev.preventDefault(); UI.saveJSON(); return; }
      if (mod && ev.key.toLowerCase() === 'e') { ev.preventDefault(); UI.exportWav(); return; }
    });
  }

  function onStoreChange(reason) {
    var s = SG.Store.state;
    if (UI.waveEditor) UI.waveEditor.requestDraw();
    if (UI.harmEditor) UI.harmEditor.requestDraw();
    if (UI.envEditor) UI.envEditor.requestDraw();
    renderRules();
    UI.syncControls();
    syncTransport();
    syncVoiceInfo();
    syncRuleErrors();
    if (reason === 'update' || reason === 'transient') {
      var presetSel = $('#sel-preset');
      if (presetSel && presetSel.value) presetSel.value = '';      /* patch is no longer stock */
    }
    if (reason !== 'ui') requestPreview();
    writeHashSoon();
    $('#btn-undo').disabled = !SG.Store.canUndo();
    $('#btn-redo').disabled = !SG.Store.canRedo();
    var phaseTag = $('#harm-phase-tag');
    if (phaseTag) phaseTag.style.display = s.ui.showPhase ? '' : 'none';
    var ro = $('#note-readout');
    if (ro && document.activeElement !== $('#sel-note')) {
      ro.textContent = U.noteName(s.note.midi) + ' · ' + U.fmt.hz(U.midiToFreq(s.note.midi));
    }
    var snap = $('#btn-snap');
    if (snap) { snap.classList.toggle('is-on', !!s.ui.snap); snap.setAttribute('aria-pressed', s.ui.snap ? 'true' : 'false'); }
    var mir = $('#btn-mirror');
    if (mir) { mir.classList.toggle('is-on', !!s.ui.mirror); mir.setAttribute('aria-pressed', s.ui.mirror ? 'true' : 'false'); }
    U.$$('#wave-tools .btn').forEach(function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-tool') === s.ui.waveTool);
    });
    U.$$('#env-tabs .tab').forEach(function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-env') === s.ui.envTab);
    });
    void s;
  }
  UI.onStoreChange = onStoreChange;

  function syncVoiceInfo() {
    var s = SG.Store.state;
    var el = $('#voice-info');
    if (!el) return;
    var sp = H.computeSpectrum(s, U.midiToFreq(s.note.midi), s.sample.sampleRate);
    var parts = [
      s.voice.unison + (s.voice.unison > 1 ? ' voices' : ' voice'),
      s.filter.enabled ? s.filter.type + ' ' + U.fmt.hz(s.filter.cutoff) : 'no filter',
      sp.activeCount + '/' + sp.N + ' harmonics'
    ];
    el.textContent = parts.join(' · ');
  }

  var writeHashSoon = U.debounce(function () {
    try { SG.Store.writeHash(); } catch (e) { /* ignore */ }
  }, 900);

  /* ------------------------------------------------------------- animation */
  function tick() {
    rafId = root.requestAnimationFrame(tick);
    if (SG.Audio.playing) {
      if (UI.envEditor) UI.envEditor.requestDraw();
      drawOutput();
      var lvl = SG.Audio.getLevel();
      var el = $('#status-ctx');
      if (el) {
        el.textContent = SG.Audio.ctx.state + ' · ' + (SG.Audio.loop ? 'loop' : 'one-shot') +
          ' · peak ' + U.fmt.db(lvl.peak);
      }
    }
    void rafId;
  }

})(typeof window !== 'undefined' ? window : globalThis);
