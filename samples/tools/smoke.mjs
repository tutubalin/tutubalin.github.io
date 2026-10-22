/* ==========================================================================
   tools/smoke.mjs — boots the real app under Node (DOM + Web Audio shims) and
   exercises the DSP logic, the editors and the export path.

   run:  node tools/smoke.mjs
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createDocument, getComputedStyleShim } from './shim/dom.mjs';
import { AudioContextShim, OfflineAudioContextShim, problems as audioProblems } from './shim/audio.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ------------------------------------------------------------- assertions */
let pass = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (err) { failures.push([name, err]); console.log('  ✗ ' + name + '\n      ' + (err && err.message)); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (err) { failures.push([name, err]); console.log('  ✗ ' + name + '\n      ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : err.message)); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function near(a, b, eps, msg) {
  if (!isFinite(a)) throw new Error((msg || 'value') + ': not finite (' + a + ')');
  if (Math.abs(a - b) > (eps === undefined ? 1e-6 : eps)) throw new Error((msg || '') + ' expected ~' + b + ' got ' + a);
}
const section = (t) => console.log('\n' + t);

/* -------------------------------------------------------------- globals */
const frames = [];
globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
globalThis.cancelAnimationFrame = () => {};
function flushFrames(times = 1) {
  for (let i = 0; i < times; i++) {
    const batch = frames.splice(0, frames.length);
    for (const fn of batch) fn(performance.now());
  }
}
globalThis.devicePixelRatio = 2;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

/* window-level events: Node's global EventTarget needs real Event objects, so
   give the app a plain listener registry instead. */
const winListeners = {};
function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}
defineGlobal('addEventListener', (type, fn) => { (winListeners[type] = winListeners[type] || []).push(fn); });
defineGlobal('removeEventListener', (type, fn) => {
  const l = winListeners[type]; if (!l) return;
  const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
});
defineGlobal('dispatchEvent', (ev) => {
  ev.preventDefault = ev.preventDefault || function () { ev.defaultPrevented = true; };
  ev.stopPropagation = ev.stopPropagation || function () {};
  const l = winListeners[ev.type];
  if (l) for (const fn of l.slice()) fn(ev);
  return true;
});
globalThis.AudioContext = AudioContextShim;
globalThis.OfflineAudioContext = OfflineAudioContextShim;
defineGlobal('navigator', { userAgent: 'node-smoke', clipboard: { writeText: async () => {} } });
defineGlobal('location', { href: 'http://localhost/index.html', hash: '', replace() {} });
defineGlobal('history', { replaceState() {} });
defineGlobal('prompt', () => null);
defineGlobal('alert', () => {});

let lastDownload = null;
globalThis.URL.createObjectURL = (blob) => { lastDownload = blob; return 'blob:shim/1'; };
globalThis.URL.revokeObjectURL = () => {};

class FileReaderShim {
  readAsText(blobOrFile) {
    const self = this;
    Promise.resolve(blobOrFile && blobOrFile.text ? blobOrFile.text() : Promise.resolve(String(blobOrFile)))
      .then((text) => { self.result = text; if (self.onload) self.onload({ target: self }); });
  }
}
globalThis.FileReader = FileReaderShim;

/* --------------------------------------------------------------- boot */
const html = read('index.html');
const css = read('styles.css');
const document = createDocument(html, css);
globalThis.window = globalThis;
globalThis.document = document;
globalThis.getComputedStyle = getComputedStyleShim(document);
globalThis.self = globalThis;

const scriptSrcs = [...document.querySelectorAll('script')]
  .map((s) => s.getAttribute('src'))
  .filter(Boolean);
console.log('loading ' + scriptSrcs.length + ' scripts: ' + scriptSrcs.join(', '));
for (const src of scriptSrcs) {
  const code = read(src);
  try { vm.runInThisContext(code, { filename: src }); }
  catch (err) { console.error('FAILED to load ' + src + ': ' + err.message); process.exit(1); }
}
flushFrames(2);

const SG = globalThis.SG;
const U = SG.util;
ok(!!SG && !!SG.Store && !!SG.UI, 'SG namespace bootstrapped');

/* ------------------------------------------------------------ helpers */
function spectrumFor(patch, midi = 60, sr = 44100) {
  const s = SG.Store.sanitize(patch || SG.Store.state);
  return SG.Harmonics.computeSpectrum(s, U.midiToFreq(midi), sr);
}
function pointer(el, type, x, y, extra = {}) {
  el.dispatchEvent(Object.assign({
    type, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    pointerId: 1, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
    preventDefault() {}, stopPropagation() {}, target: el
  }, extra));
}
function resetPatch(patch) {
  SG.Store.loadPatch(patch ? Object.assign(SG.Store.defaults(), patch) : SG.Store.defaults());
  flushFrames(2);
}

/* ====================================================================== */
section('1 · store & sanitising');

check('defaults sanitise without changes', () => {
  const d = SG.Store.defaults();
  const s = SG.Store.sanitize(JSON.parse(JSON.stringify(d)));
  ok(s.harmonics.count === d.harmonics.count, 'count preserved');
  ok(s.envelopes.amp.points.length === 4, 'amp envelope preserved');
  ok(s.envelopes.amp.points[0].t === 0 && s.envelopes.amp.points[3].t === 1, 'ends pinned');
});

check('garbage input is sanitised, not crashed', () => {
  const s = SG.Store.sanitize({
    note: { midi: 999 }, harmonics: { count: -5, rules: [{ amp: null, mode: 'nope' }], overrides: null },
    envelopes: { amp: { points: 'nope' }, pitch: { points: [{ t: 5, v: 99 }] } }, sample: { duration: -3 }
  });
  ok(s.note.midi === 127, 'midi clamped: ' + s.note.midi);
  ok(s.harmonics.count >= 2, 'count clamped');
  ok(s.harmonics.rules[0].mode === 'set', 'unknown mode → set');
  ok(s.envelopes.amp.points.length >= 2, 'amp envelope repaired');
  ok(s.envelopes.pitch.points[0].t === 0, 'pitch t clamped');
  ok(s.sample.duration >= 0.01, 'duration clamped');
});

check('undo / redo round-trips a mutation', () => {
  resetPatch();
  const before = SG.Store.state.harmonics.count;
  SG.Store.update((s) => { s.harmonics.count = 40; });
  ok(SG.Store.state.harmonics.count === 40, 'applied');
  ok(SG.Store.undo(), 'undo ran');
  ok(SG.Store.state.harmonics.count === before, 'restored');
  ok(SG.Store.redo(), 'redo ran');
  ok(SG.Store.state.harmonics.count === 40, 're-applied');
});

check('gesture grouping collapses a drag into one undo step', () => {
  resetPatch();
  SG.Store.beginGesture();
  for (let i = 0; i < 10; i++) SG.Store.updateTransient((s) => { s.harmonics.count = 5 + i; });
  SG.Store.endGesture();
  const undoCountBefore = SG.Store.canUndo();
  ok(undoCountBefore, 'one snapshot exists');
  SG.Store.undo();
  ok(SG.Store.state.harmonics.count === 24, 'single undo restores the pre-drag value, got ' + SG.Store.state.harmonics.count);
});

check('a stuck control gesture cannot swallow the next undo step', () => {
  resetPatch();
  SG.Store.beginGesture();                 /* e.g. a slider that keeps focus */
  const before = SG.Store.state.harmonics.count;
  SG.Store.beginGesture();                 /* canvas pointerdown */
  SG.Store.updateTransient((s) => { s.harmonics.count = 50; });
  SG.Store.updateTransient((s) => { s.harmonics.count = 51; });
  SG.Store.endGesture();
  ok(SG.Store.canUndo(), 'an undo step exists');
  SG.Store.undo();
  ok(SG.Store.state.harmonics.count === before,
    'undo restores the pre-drag value, got ' + SG.Store.state.harmonics.count);
});

check('transient edits outside a gesture are not undoable', () => {
  resetPatch();
  SG.Store.update((s) => { s.harmonics.count = 30; });
  SG.Store.updateTransient((s) => { s.harmonics.count = 31; });   /* e.g. note trigger */
  SG.Store.undo();
  ok(SG.Store.state.harmonics.count === 24, 'undo skips transient edits: ' + SG.Store.state.harmonics.count);
});

check('JSON + URL hash round-trip', () => {
  resetPatch();
  SG.Store.update((s) => {
    s.harmonics.count = 33;
    s.harmonics.rules[0].amp = 'prime(n) ? 1/n : 0';
    s.envelopes.amp.points[1].t = 0.25;
    s.note.midi = 71;
  });
  const json = SG.Store.toJSON(false);
  const restored = SG.Store.sanitize(JSON.parse(json));
  ok(restored.harmonics.count === 33 && restored.note.midi === 71, 'json round-trip');
  ok(restored.envelopes.amp.points[1].t === 0.25, 'envelope round-trip');

  const hash = SG.Store.toHash();
  ok(hash.startsWith('#p=') && hash.length > 20, 'hash produced');
  resetPatch();
  ok(SG.Store.state.harmonics.count === 24, 'reset');
  ok(SG.Store.fromHash(hash), 'hash parsed');
  ok(SG.Store.state.harmonics.count === 33 && SG.Store.state.note.midi === 71, 'hash round-trip');
  ok(SG.Store.fromHash('#p=not-valid-base64!!!') === false, 'bad hash rejected');
  resetPatch();
});

/* ====================================================================== */
section('2 · envelope model');

check('linear segments interpolate exactly', () => {
  const env = SG.Envelope.make([[0, 0], [0.5, 1], [1, 0.25]]);
  near(SG.Envelope.at(env, 0), 0);
  near(SG.Envelope.at(env, 0.25), 0.5);
  near(SG.Envelope.at(env, 0.5), 1);
  near(SG.Envelope.at(env, 0.75), 0.625);
  near(SG.Envelope.at(env, 1), 0.25);
  near(SG.Envelope.at(env, -1), 0, 1e-9, 'before start');
  near(SG.Envelope.at(env, 2), 0.25, 1e-9, 'after end');
});

check('curvature keeps endpoints and monotonicity', () => {
  for (const c of [-1, -0.5, 0, 0.5, 1]) {
    const env = SG.Envelope.make([[0, 0, c], [1, 1]]);
    near(SG.Envelope.at(env, 0), 0, 1e-9, 'c=' + c + ' start');
    near(SG.Envelope.at(env, 1), 1, 1e-9, 'c=' + c + ' end');
    let prev = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const v = SG.Envelope.at(env, i / 100);
      ok(v >= prev - 1e-9, 'monotonic at c=' + c + ' i=' + i);
      prev = v;
    }
    const mid = SG.Envelope.at(env, 0.5);
    if (c > 0) ok(mid < 0.5, 'positive curvature bows low, got ' + mid);
    if (c < 0) ok(mid > 0.5, 'negative curvature bows high, got ' + mid);
  }
});

check('solveCurvature inverts the curve at x=0.5', () => {
  for (const target of [0.05, 0.2, 0.5, 0.8, 0.95]) {
    const c = SG.Envelope.solveCurvature(0, 1, target);
    const env = SG.Envelope.make([[0, 0, c], [1, 1]]);
    near(SG.Envelope.at(env, 0.5), target, 1e-3, 'target ' + target + ' → c ' + c.toFixed(3));
  }
});

check('hold segments stay flat then step', () => {
  const env = SG.Envelope.make([[0, 1, 0, true], [0.5, 0.2, 0, true], [1, 0]]);
  near(SG.Envelope.at(env, 0.1), 1);
  near(SG.Envelope.at(env, 0.49), 1);
  near(SG.Envelope.at(env, 0.5), 0.2);
  near(SG.Envelope.at(env, 0.9), 0.2);
  near(SG.Envelope.at(env, 1), 0);
});

check('curve sampling matches evaluation', () => {
  const env = SG.Envelope.make([[0, 0, 0.6], [0.3, 1, -0.4], [1, 0]]);
  const curve = SG.Envelope.sampleCurve(env, 1024);
  ok(curve.length === 1024 && curve instanceof Float32Array, 'length/type');
  for (let i = 0; i < 1024; i += 97) near(curve[i], SG.Envelope.at(env, i / 1023), 1e-6, 'sample ' + i);
});

check('insert / move / remove keep the envelope legal', () => {
  const env = SG.Envelope.make([[0, 0], [1, 1]]);
  const idx = SG.Envelope.insertPoint(env, 0.4, 0.7);
  ok(env.points.length === 3 && env.points[idx].t === 0.4, 'inserted at ' + idx);
  SG.Envelope.movePoint(env, idx, 9, -9, { min: 0, max: 1 });
  ok(env.points[idx].t < 1 && env.points[idx].t > 0, 'time clamped between neighbours: ' + env.points[idx].t);
  ok(env.points[idx].v === 0, 'value clamped to 0, got ' + env.points[idx].v);
  SG.Envelope.movePoint(env, 0, 0.5, 0.5, { min: 0, max: 1 });
  ok(env.points[0].t === 0, 'first point time is locked');
  SG.Envelope.movePoint(env, 2, 0.5, 0.5, { min: 0, max: 1 });
  ok(env.points[2].t === 1, 'last point time is locked');
  ok(SG.Envelope.removePoint(env, 0) === -1, 'cannot remove the first point');
  ok(SG.Envelope.removePoint(env, 1) === 1, 'middle point removed');
  ok(env.points.length === 2, 'back to two points');
  ok(SG.Envelope.removePoint(env, 1) === -1, 'minimum two points enforced');
});

check('every built-in envelope shape is valid', () => {
  const all = Object.assign({}, SG.Envelope.SHAPES, SG.Envelope.MOD_SHAPES);
  const keys = Object.keys(all);
  ok(keys.length >= 14, 'shape count ' + keys.length);
  for (const k of keys) {
    const env = SG.Envelope.make(all[k].pts);
    ok(env.points.length >= 2, k + ': enough points');
    near(env.points[0].t, 0, 1e-9, k + ': starts at 0');
    near(env.points[env.points.length - 1].t, 1, 1e-9, k + ': ends at 1');
    for (let i = 1; i < env.points.length; i++) ok(env.points[i].t > env.points[i - 1].t, k + ': sorted');
    for (let i = 0; i <= 200; i++) {
      const v = SG.Envelope.at(env, i / 200);
      ok(isFinite(v) && v >= -1.001 && v <= 1.001, k + ': value in range at ' + (i / 200) + ' → ' + v);
    }
  }
});

/* ====================================================================== */
section('3 · harmonic engine');

check('square rule yields odd harmonics with 1/n amplitude', () => {
  const sp = spectrumFor({ harmonics: { count: 16, rules: [{ id: 'r', enabled: true, amp: 'odd(n) ? 1/n : 0', mode: 'set', amount: 1, phase: '', phaseMode: 'add' }] } });
  ok(sp.errors.length === 0, 'no rule errors: ' + JSON.stringify(sp.errors));
  near(sp.ampRaw[1], 1, 1e-9, 'fundamental normalised to 1');
  for (let n = 1; n <= 16; n++) {
    if (n % 2 === 0) near(sp.ampRaw[n], 0, 1e-12, 'even harmonic ' + n + ' silent');
    else near(sp.ampRaw[n], 1 / n, 1e-9, 'odd harmonic ' + n);
  }
});

check('normalisation modes behave', () => {
  const patch = (mode) => ({ harmonics: { count: 8, normalize: mode, rules: [{ id: 'r', enabled: true, amp: '1', mode: 'set', amount: 1 }] } });
  const peak = spectrumFor(patch('peak'));
  near(peak.ampRaw[1], 1, 1e-9, 'peak mode → max 1');
  const rms = spectrumFor(patch('rms'));
  let sumSq = 0; for (let n = 1; n <= 8; n++) sumSq += rms.ampRaw[n] * rms.ampRaw[n];
  near(Math.sqrt(sumSq), 1, 1e-6, 'rms mode → unit sum of squares');
  const none = spectrumFor(patch('none'));
  near(none.ampRaw[3], 1, 1e-9, 'raw mode untouched');
});

check('overrides win over rules and can be cleared', () => {
  const patch = { harmonics: { count: 8, rules: [{ id: 'r', enabled: true, amp: 'odd(n) ? 1/n : 0', mode: 'set', amount: 1 }] } };
  let sp = spectrumFor(patch);
  near(sp.ampRaw[2], 0, 1e-12, 'even harmonic silent before override');
  patch.harmonics.overrides = { amp: [{ n: 2, v: 0.6 }], phase: [{ n: 2, v: 0.25 }] };
  sp = spectrumFor(patch);
  near(sp.ampRaw[2], 0.6, 1e-9, 'override applied');
  ok(sp.overridden[2] === 1, 'flagged as override');
  ok(sp.overridden[1] === 0, 'rule harmonic not flagged');
  near(sp.phase[2], 0.25, 1e-9, 'phase override applied');
  patch.harmonics.overrides = { amp: [], phase: [] };
  sp = spectrumFor(patch);
  near(sp.ampRaw[2], 0, 1e-12, 'override cleared');
});

check('rule combination modes', () => {
  const two = (mode, amount) => ({
    harmonics: {
      count: 6, normalize: 'none',
      rules: [
        { id: 'a', enabled: true, amp: '1', mode: 'set', amount: 1 },
        { id: 'b', enabled: true, amp: '0.5', mode, amount }
      ]
    }
  });
  near(spectrumFor(two('mul', 1)).ampRaw[3], 0.5, 1e-9, 'mul');
  near(spectrumFor(two('add', 1)).ampRaw[3], 1.5, 1e-9, 'add');
  near(spectrumFor(two('max', 1)).ampRaw[3], 1, 1e-9, 'max');
  near(spectrumFor(two('min', 1)).ampRaw[3], 0.5, 1e-9, 'min');
  near(spectrumFor(two('set', 2)).ampRaw[3], 1, 1e-9, 'set with amount 2');
  const off = two('mul', 1); off.harmonics.rules[1].enabled = false;
  near(spectrumFor(off).ampRaw[3], 1, 1e-9, 'disabled rule ignored');
});

check('anti-alias drops harmonics above Nyquist', () => {
  const patch = { harmonics: { count: 32, antiAlias: true, rules: [{ id: 'r', enabled: true, amp: '1/n', mode: 'set', amount: 1 }] } };
  const sp = spectrumFor(patch, 60, 44100);          /* 261.6 Hz → ~84 harmonics fit */
  ok(sp.nyquistN >= 32, 'all 32 harmonics fit at C4: ' + sp.nyquistN);
  ok(sp.amp[32] > 0, 'top harmonic audible');
  const hi = spectrumFor(patch, 108, 44100);         /* 4186 Hz → only ~5 fit */
  ok(hi.nyquistN < 10, 'few harmonics fit at C8: ' + hi.nyquistN);
  ok(hi.amp[hi.nyquistN + 1] === 0, 'above Nyquist zeroed');
  ok(hi.ampRaw[hi.nyquistN + 1] > 0, 'raw spectrum keeps them for display');
  ok(hi.muted[hi.nyquistN + 1] === 1, 'muted flag set');
  const patchOff = JSON.parse(JSON.stringify(patch)); patchOff.harmonics.antiAlias = false;
  const off = spectrumFor(patchOff, 108, 44100);
  ok(off.amp[off.nyquistN + 1] > 0, 'anti-alias off keeps them');
});

check('bad expressions are reported, not thrown', () => {
  const sp = spectrumFor({ harmonics: { count: 8, rules: [{ id: 'bad', enabled: true, amp: 'this is not js(( ', mode: 'set', amount: 1 }] } });
  ok(sp.errors.length === 1 && sp.errors[0].rule === 'bad', 'syntax error reported');
  const sp2 = spectrumFor({ harmonics: { count: 8, rules: [{ id: 'nan', enabled: true, amp: 'log(0)', mode: 'set', amount: 1 }] } });
  ok(sp2.errors.length >= 1, 'non-finite values reported');
  ok(isFinite(sp2.ampRaw[1]), 'spectrum still finite');
});

check('phase bases and rule phases', () => {
  const mk = (phaseBase, rulePhase) => ({
    harmonics: {
      count: 4, phaseBase, seed: 7,
      rules: [{ id: 'r', enabled: true, amp: '1', mode: 'set', amount: 1, phase: rulePhase || '', phaseMode: rulePhase ? 'set' : 'add' }]
    }
  });
  const zero = spectrumFor(mk('zero'));
  for (let n = 1; n <= 4; n++) near(zero.phase[n], 0, 1e-9, 'zero phase');
  const alt = spectrumFor(mk('alt'));
  near(alt.phase[1], 0, 1e-9, 'alt n=1'); near(alt.phase[2], 0.5, 1e-9, 'alt n=2');
  const cos = spectrumFor(mk('cos'));
  near(cos.phase[1], 0.25, 1e-9, 'cos base');
  const rnd = spectrumFor(mk('rand'));
  const rnd2 = spectrumFor(mk('rand'));
  for (let n = 1; n <= 4; n++) near(rnd.phase[n], rnd2.phase[n], 1e-12, 'seeded phase reproducible');
  const expr = spectrumFor(mk('zero', '0.5'));
  near(expr.phase[1], 0.5, 1e-9, 'rule phase expression');
  const neg = spectrumFor({ harmonics: { count: 2, rules: [{ id: 'r', enabled: true, amp: '-1', mode: 'set', amount: 1 }] } });
  near(neg.ampRaw[1], 1, 1e-9, 'negative amp becomes positive');
  near(neg.phase[1], 0.5, 1e-9, 'negative amp flips phase');
});

check('DFT analysis round-trips a drawn sine', () => {
  const M = SG.Harmonics.DFT_M;
  const wave = new Float32Array(M);
  for (let i = 0; i < M; i++) wave[i] = Math.sin(U.TAU * 3 * i / M);      /* 3rd harmonic */
  const res = SG.Harmonics.spectrumFromWaveform(wave, 16);
  near(res.amp[3], 1, 1e-6, 'harmonic 3 detected');
  for (let n = 1; n <= 16; n++) if (n !== 3) ok(res.amp[n] < 1e-6, 'harmonic ' + n + ' silent, got ' + res.amp[n]);
  near(res.phase[3], 0, 1e-6, 'phase of a sine is 0 turns');
});

check('DFT recovers phase and amplitude of a shifted cosine', () => {
  const M = SG.Harmonics.DFT_M;
  const wave = new Float32Array(M);
  for (let i = 0; i < M; i++) wave[i] = 0.5 * Math.cos(U.TAU * 5 * i / M);
  const res = SG.Harmonics.spectrumFromWaveform(wave, 12);
  near(res.amp[5], 1, 1e-6, 'peak-normalised to 1');
  near(res.phase[5], 0.25, 1e-6, 'cosine phase = 0.25 turns');
  /* rebuild the waveform from the analysed spectrum and compare */
  const rebuilt = SG.Harmonics.waveformFromSpectrum(res.amp, res.phase, 12, M);
  let maxErr = 0;
  for (let i = 0; i < M; i++) maxErr = Math.max(maxErr, Math.abs(rebuilt[i] * res.peak - wave[i]));
  ok(maxErr < 1e-3, 'resynthesis matches the drawing, max error ' + maxErr);
});

check('wave tools preserve length and behave', () => {
  const M = 64;
  const wave = new Float32Array(M);
  for (let i = 0; i < M; i++) wave[i] = Math.sin(U.TAU * i / M) + 0.3;
  const dc = SG.Harmonics.WaveOps.removeDC(wave);
  let mean = 0; for (let i = 0; i < M; i++) mean += dc[i];
  near(mean / M, 0, 1e-6, 'DC removed');
  const inv = SG.Harmonics.WaveOps.invert(wave);
  near(inv[5], -wave[5], 1e-12, 'inverted');
  const flip = SG.Harmonics.WaveOps.flip(wave);
  near(flip[M - 1 - 5], wave[5], 1e-12, 'flipped');
  const norm = SG.Harmonics.WaveOps.normalize(wave);
  let peak = 0; for (let i = 0; i < M; i++) peak = Math.max(peak, Math.abs(norm[i]));
  near(peak, 1, 1e-9, 'normalised');
  const sm = SG.Harmonics.WaveOps.smooth(wave, 2);
  ok(sm.length === M, 'smooth keeps length');
  const mir = SG.Harmonics.WaveOps.mirror(wave);
  near(mir[M - 1], -wave[0], 1e-9, 'mirrored odd symmetry');
});

check('every documented recipe compiles and evaluates', () => {
  for (const rec of SG.Harmonics.RECIPES) {
    const compiled = SG.Harmonics.compile(rec.expr);
    ok(!compiled.error, rec.label + ' compiles: ' + compiled.error);
    const sp = spectrumFor({
      harmonics: {
        count: 48, rules: [{ id: 'r', enabled: true, amp: rec.expr, mode: rec.mode || 'set', amount: 1, phase: rec.phase || '', phaseMode: rec.phase ? 'set' : 'add' }]
      }
    }, 45, 44100);
    ok(sp.errors.length === 0, rec.label + ' has no runtime errors: ' + JSON.stringify(sp.errors));
    let anyAudible = false;
    for (let n = 1; n <= 48; n++) {
      ok(isFinite(sp.ampRaw[n]) && sp.ampRaw[n] >= 0, rec.label + ' harmonic ' + n + ' = ' + sp.ampRaw[n]);
      if (sp.ampRaw[n] > 1e-6) anyAudible = true;
    }
    ok(anyAudible, rec.label + ' produces sound');
  }
});

check('every helper and constant is reachable from an expression', () => {
  const bad = SG.Harmonics.selfTest();
  ok(bad.length === 0, bad.length + ' unreachable scope names: ' + bad.join(', '));
});

check('helper functions return sane values', () => {
  const sp = spectrumFor({
    harmonics: {
      count: 24, normalize: 'none',
      rules: [{ id: 'r', enabled: true, amp: 'prime(n) + even(n) + isFib(n) + mod(n,3,0) + coprime(n,4)', mode: 'set', amount: 1 }]
    }
  });
  ok(sp.errors.length === 0, 'selection helpers evaluate');
  /* n=2: prime ✓ + even ✓ + isFib ✓ + mod(2,3,0) ✗ + coprime(2,4) ✗ = 3 */
  near(sp.ampRaw[2], 3, 1e-9, 'n=2 helper sum');
  const sp2 = spectrumFor({ harmonics: { count: 12, normalize: 'none', rules: [{ id: 'r', enabled: true, amp: 'pulse(n, 0.5)', mode: 'set', amount: 1 }] } });
  ok(sp2.ampRaw[2] < 1e-9, 'pulse 50% kills even harmonics, got ' + sp2.ampRaw[2]);
  ok(sp2.ampRaw[1] > 0.6 && sp2.ampRaw[1] < 0.64, 'pulse fundamental ≈ 2/π = ' + sp2.ampRaw[1]);
  const sp3 = spectrumFor({ harmonics: { count: 12, normalize: 'none', seed: 5, rules: [{ id: 'r', enabled: true, amp: 'rand(n)', mode: 'set', amount: 1 }] } });
  const sp4 = spectrumFor({ harmonics: { count: 12, normalize: 'none', seed: 5, rules: [{ id: 'r', enabled: true, amp: 'rand(n)', mode: 'set', amount: 1 }] } });
  for (let n = 1; n <= 12; n++) near(sp3.ampRaw[n], sp4.ampRaw[n], 1e-12, 'rand reproducible at n=' + n);
  ok(sp3.ampRaw[1] >= 0 && sp3.ampRaw[1] <= 1, 'rand in 0..1');
});

/* ====================================================================== */
section('4 · preset library');

await checkAsync('every factory patch loads, analyses and renders', async () => {
  for (const preset of SG.Presets.PATCHES) {
    const patch = U.mergeDeep(SG.Store.defaults(), U.deepClone(preset.patch));
    const state = SG.Store.sanitize(patch);
    const sp = SG.Harmonics.computeSpectrum(state, U.midiToFreq(state.note.midi), state.sample.sampleRate);
    ok(sp.errors.length === 0, preset.name + ': spectrum errors ' + JSON.stringify(sp.errors));
    ok(sp.activeCount > 0, preset.name + ': has audible harmonics');
    ok(isFinite(sp.wavePeak) && sp.wavePeak > 0, preset.name + ': finite wave peak');
    for (const key of ['amp', 'pitch', 'filter']) {
      const env = state.envelopes[key];
      const curve = SG.Envelope.sampleCurve(env, 64);
      for (let i = 0; i < curve.length; i++) ok(isFinite(curve[i]), preset.name + '/' + key + ': finite curve at ' + i);
      if (key === 'amp') {
        let min = Infinity; for (let i = 0; i < curve.length; i++) min = Math.min(min, curve[i]);
        ok(min >= -1e-9, preset.name + ': amp envelope never negative (' + min + ')');
      }
    }
    const buffer = await SG.Audio.renderOffline(state, state.note.midi);
    ok(buffer.length > 0, preset.name + ': rendered');
    const stats = SG.Wav.stats(buffer);
    ok(isFinite(stats.peak) && stats.peak > 0 && stats.peak <= 1.0001, preset.name + ': peak ' + stats.peak);
    const blob = SG.Wav.encode(buffer, state.sample.bitDepth);
    ok(blob.size > 44, preset.name + ': wav bytes ' + blob.size);
  }
});
check('every waveform preset produces a legal spectrum', () => {
  for (const wp of SG.Presets.WAVEFORMS) {
    const patch = U.mergeDeep(SG.Store.defaults(), U.deepClone(wp.patch));
    const state = SG.Store.sanitize(patch);
    const sp = SG.Harmonics.computeSpectrum(state, U.midiToFreq(state.note.midi), state.sample.sampleRate);
    ok(sp.errors.length === 0, wp.label + ': ' + JSON.stringify(sp.errors));
    ok(sp.activeCount > 0, wp.label + ': audible');
    ok(isFinite(sp.wavePeak) && sp.wavePeak > 0, wp.label + ': peak finite');
  }
});

/* ====================================================================== */
section('5 · WAV writer');

await checkAsync('16-bit mono header and samples are correct', async () => {
  const buf = { channels: [new Float32Array([0, 0.5, -0.5, 1, -1])], sampleRate: 8000 };
  const blob = SG.Wav.encode(buf, 16);
  const dv = new DataView(await blob.arrayBuffer());
  const str = (o, n) => String.fromCharCode(...[...Array(n)].map((_, i) => dv.getUint8(o + i)));
  ok(str(0, 4) === 'RIFF', 'RIFF magic');
  ok(dv.getUint32(4, true) === dv.byteLength - 8, 'RIFF size ' + dv.getUint32(4, true) + ' vs ' + (dv.byteLength - 8));
  ok(str(8, 4) === 'WAVE', 'WAVE magic');
  ok(str(12, 4) === 'fmt ', 'fmt chunk');
  ok(dv.getUint32(16, true) === 16, 'fmt size');
  ok(dv.getUint16(20, true) === 1, 'PCM format tag');
  ok(dv.getUint16(22, true) === 1, 'mono');
  ok(dv.getUint32(24, true) === 8000, 'sample rate');
  ok(dv.getUint32(28, true) === 16000, 'byte rate');
  ok(dv.getUint16(32, true) === 2, 'block align');
  ok(dv.getUint16(34, true) === 16, 'bit depth');
  ok(str(36, 4) === 'data', 'data chunk');
  ok(dv.getUint32(40, true) === 10, 'data size');
  ok(dv.byteLength === 44 + 10, 'total length ' + dv.byteLength);
  ok(dv.getInt16(44, true) === 0, 'sample 0');
  ok(Math.abs(dv.getInt16(46, true) - 16383) <= 1, 'sample +0.5 → ' + dv.getInt16(46, true));
  ok(dv.getInt16(48, true) === -16384, 'sample -0.5 → ' + dv.getInt16(48, true));
  ok(dv.getInt16(50, true) === 32767, 'sample +1');
  ok(dv.getInt16(52, true) === -32768, 'sample -1');
});

await checkAsync('24-bit and 32-bit float headers are correct', async () => {
  const buf = { channels: [new Float32Array([0.25, -0.25]), new Float32Array([0.5, -0.5])], sampleRate: 44100 };
  const b24 = new DataView(await SG.Wav.encode(buf, 24).arrayBuffer());
  ok(b24.getUint16(20, true) === 1, '24-bit is PCM');
  ok(b24.getUint16(22, true) === 2, '24-bit stereo');
  ok(b24.getUint16(34, true) === 24, '24-bit depth');
  ok(b24.getUint32(40, true) === 12, '24-bit data size');
  const raw24 = b24.getUint8(44) | (b24.getUint8(45) << 8) | (b24.getUint8(46) << 16);
  const v = (raw24 << 8) >> 8;
  ok(Math.abs(v - Math.round(0.25 * 8388607)) <= 1, '24-bit sample ' + v);

  const b32 = new DataView(await SG.Wav.encode(buf, 32).arrayBuffer());
  ok(b32.getUint32(16, true) === 18, 'float fmt size');
  ok(b32.getUint16(20, true) === 3, 'IEEE float tag');
  ok(b32.getUint16(34, true) === 32, 'float depth');
  ok(b32.getUint16(36, true) === 0, 'cbSize');
  ok(Math.abs(b32.getFloat32(46, true) - 0.25) < 1e-7, 'float sample interleaved');
  ok(Math.abs(b32.getFloat32(50, true) - 0.5) < 1e-7, 'float second channel');
});

await checkAsync('NaN input is clamped, not written as garbage', async () => {
  const buf = { channels: [new Float32Array([NaN, Infinity, -Infinity, 2, -3])], sampleRate: 8000 };
  const dv = new DataView(await SG.Wav.encode(buf, 16).arrayBuffer());
  for (let i = 0; i < 5; i++) {
    const s = dv.getInt16(44 + i * 2, true);
    ok(s >= -32768 && s <= 32767, 'sample ' + i + ' in range: ' + s);
  }
  ok(dv.getInt16(44, true) === 0, 'NaN → 0');
  ok(dv.getInt16(50, true) === 32767, '+Inf → full scale');
  ok(dv.getInt16(52, true) === -32768, '-Inf → full scale negative');
});

/* ====================================================================== */
section('6 · app boot & DOM wiring');

check('UI booted and populated', () => {
  ok(document.getElementById('sel-note').children.length >= 7, 'note select filled');
  ok(document.getElementById('sel-preset').children.length >= 2, 'preset select filled');
  ok(document.getElementById('wave-presets').children.length === SG.Presets.WAVEFORMS.length, 'waveform preset buttons');
  ok(document.getElementById('env-shapes').children.length > 5, 'envelope shape buttons');
  ok(document.getElementById('rule-list').children.length === SG.Store.state.harmonics.rules.length, 'rule rows');
  ok(document.getElementById('expr-ref').children.length >= 3, 'expression reference built');
  ok(document.getElementById('keyboard').children.length === 25, 'piano keys');
  ok(!!UI_hasEditors(), 'editors created');
});
function UI_hasEditors() { return SG.UI.waveEditor && SG.UI.harmEditor && SG.UI.envEditor; }

check('all canvases draw without throwing', () => {
  SG.UI.waveEditor.render();
  SG.UI.harmEditor.render();
  SG.UI.envEditor.render();
  SG.UI.drawOutput();
  ok(true, 'drawn');
});

check('every envelope tab draws', () => {
  for (const tab of ['amp', 'pitch', 'filter']) {
    document.getElementById('env-tabs').children.find((c) => c.getAttribute('data-env') === tab).click();
    flushFrames(1);
    SG.UI.envEditor.render();
    ok(SG.Store.state.ui.envTab === tab, 'tab switched to ' + tab);
    ok(document.getElementById('env-shapes').children.length > 3, 'shapes rebuilt for ' + tab);
  }
  document.getElementById('env-tabs').children[0].click();
  flushFrames(1);
});

check('transport buttons drive the audio engine', () => {
  resetPatch();
  document.getElementById('btn-play').click();
  ok(SG.Audio.playing === true, 'playing');
  const ctx = SG.Audio.ctx;
  const oscs = ctx._nodes.filter((n) => n.kind === 'oscillator');
  ok(oscs.length >= 1, 'oscillator created');
  ok(oscs[0].started !== null, 'oscillator started');
  ok(oscs[0].wave && oscs[0].wave.real.length === SG.Store.state.harmonics.count + 1, 'periodic wave sized to harmonic count');
  const gains = ctx._nodes.filter((n) => n.kind === 'gain');
  ok(gains.some((g) => g.gain.events.some((e) => e.method === 'curve')), 'amp envelope scheduled as a curve');
  ctx._advance(2);
  SG.Audio.schedule();
  document.getElementById('btn-stop').click();
  ok(SG.Audio.playing === false, 'stopped');
});

check('loop scheduling keeps queueing passes', () => {
  resetPatch();
  SG.Store.update((s) => { s.transport.loop = true; });
  document.getElementById('btn-loop').click();     /* toggles off */
  ok(SG.Store.state.transport.loop === false, 'loop toggled off');
  document.getElementById('btn-loop').click();     /* toggles on */
  ok(SG.Store.state.transport.loop === true, 'loop toggled on');
  SG.Audio.play(60, { loop: true });
  const before = SG.Audio.ctx._nodes.filter((n) => n.kind === 'oscillator').length;
  SG.Audio.ctx._advance(SG.Store.state.sample.duration * 2.5);
  SG.Audio.schedule();
  SG.Audio.schedule();
  const after = SG.Audio.ctx._nodes.filter((n) => n.kind === 'oscillator').length;
  ok(after > before, 'more voices scheduled while looping (' + before + ' → ' + after + ')');
  ok(SG.Audio.position() >= 0 && SG.Audio.position() <= 1, 'playhead position in range: ' + SG.Audio.position());
  SG.Audio.stop();
});

check('unison + filter build the expected graph', () => {
  resetPatch();
  SG.Store.update((s) => {
    s.voice.unison = 4; s.voice.spread = 24; s.voice.stereo = true;
    s.filter.enabled = true; s.filter.type = 'bandpass'; s.filter.q = 6;
    s.envelopes.pitch.enabled = true; s.envelopes.pitch.depth = 12;
    s.envelopes.filter.enabled = true; s.envelopes.filter.depth = 3;
  });
  SG.Audio.stop();
  SG.Audio.play(48, { loop: false });
  const nodes = SG.Audio.ctx._nodes;
  ok(nodes.filter((n) => n.kind === 'oscillator').length >= 4, 'four oscillators');
  ok(nodes.filter((n) => n.kind === 'panner').length >= 4, 'four panners');
  const filters = nodes.filter((n) => n.kind === 'biquad');
  ok(filters.length >= 1 && filters[0].type === 'bandpass', 'filter type applied');
  ok(filters[0].frequency.events.some((e) => e.method === 'curve'), 'filter envelope scheduled');
  const oscs = nodes.filter((n) => n.kind === 'oscillator').slice(-4);
  const osc = oscs[oscs.length - 1];
  ok(osc.frequency.events.some((e) => e.method === 'curve'), 'pitch envelope scheduled on frequency');
  ok(osc.detune.events.length >= 1, 'unison detune scheduled');
  SG.Audio.stop();
});

/* ====================================================================== */
section('7 · editor interactions (synthetic pointer events)');

const cvWave = document.getElementById('cv-wave');
const cvHarm = document.getElementById('cv-harm');
const cvEnv = document.getElementById('cv-env');

check('drawing on the waveform writes harmonic overrides', () => {
  resetPatch();
  const rect = cvWave.getBoundingClientRect();
  pointer(cvWave, 'pointerdown', 40, rect.height / 2);
  for (let x = 44; x < rect.width - 20; x += 12) {
    const y = rect.height / 2 - Math.sin((x / rect.width) * Math.PI * 2) * (rect.height * 0.4);
    pointer(cvWave, 'pointermove', x, y);
  }
  pointer(cvWave, 'pointerup', rect.width - 20, rect.height / 2);
  flushFrames(2);
  const st = SG.Store.state;
  ok(st.harmonics.drawn === true, 'marked as drawn');
  ok(st.harmonics.overrides.amp.length === st.harmonics.count, 'amp overrides for every harmonic: ' + st.harmonics.overrides.amp.length);
  ok(st.harmonics.overrides.phase.length === st.harmonics.count, 'phase overrides written');
  const sp = SG.Harmonics.computeSpectrum(st, U.midiToFreq(st.note.midi), st.sample.sampleRate);
  let audible = 0;
  for (let n = 1; n <= sp.N; n++) if (sp.amp[n] > 1e-6) audible++;
  ok(audible > 0, 'the drawn wave is audible (' + audible + ' harmonics)');
  ok(sp.errors.length === 0, 'no rule errors after drawing');
  SG.UI.waveEditor.render();
});

check('waveform tools operate on the drawing', () => {
  const before = SG.Store.state.harmonics.overrides.amp.map((o) => o.v).join(',');
  document.getElementById('btn-w-invert').click();
  flushFrames(1);
  const afterInvert = SG.Store.state.harmonics.overrides.phase.map((o) => o.v);
  ok(afterInvert.some((v) => v > 0), 'invert rewrote phases');
  document.getElementById('btn-w-smooth').click();
  document.getElementById('btn-w-dc').click();
  document.getElementById('btn-w-norm').click();
  document.getElementById('btn-w-flip').click();
  flushFrames(2);
  ok(SG.Store.state.harmonics.overrides.amp.length > 0, 'still overridden');
  ok(before.length > 0, 'had a baseline');
  SG.UI.waveEditor.render();
});

check('clear-draw returns to the rule stack', () => {
  document.getElementById('btn-w-clear').click();
  flushFrames(1);
  const st = SG.Store.state;
  ok(st.harmonics.overrides.amp.length === 0, 'amp overrides cleared');
  ok(st.harmonics.overrides.phase.length === 0, 'phase overrides cleared');
  ok(st.harmonics.drawn === false, 'drawn flag cleared');
});

check('line tool paints a straight segment', () => {
  resetPatch();
  SG.Store.setUI((ui) => { ui.waveTool = 'line'; });
  document.querySelector('#wave-tools .btn[data-tool="line"]').click();
  const rect = cvWave.getBoundingClientRect();
  pointer(cvWave, 'pointerdown', 30, rect.height * 0.8);
  pointer(cvWave, 'pointermove', rect.width * 0.5, rect.height * 0.2);
  pointer(cvWave, 'pointerdown', rect.width * 0.5, rect.height * 0.2);
  flushFrames(2);
  ok(SG.Store.state.harmonics.overrides.amp.length === SG.Store.state.harmonics.count, 'line committed');
  document.querySelector('#wave-tools .btn[data-tool="draw"]').click();
});

check('harmonic bars can be painted and handed back', () => {
  resetPatch();
  SG.Store.update((s) => { s.ui.showPhase = true; s.harmonics.count = 16; });
  const rect = cvHarm.getBoundingClientRect();
  const ampY = rect.height * 0.35;
  pointer(cvHarm, 'pointerdown', rect.width * 0.2, ampY);
  pointer(cvHarm, 'pointermove', rect.width * 0.5, ampY - 20);
  pointer(cvHarm, 'pointerup', rect.width * 0.5, ampY - 20);
  flushFrames(1);
  const ov = SG.Store.state.harmonics.overrides.amp;
  ok(ov.length >= 3, 'several bars painted: ' + ov.length);
  ok(ov.every((o) => o.v >= 0 && o.v <= 1), 'values in range');
  SG.UI.harmEditor.render();

  /* phase lane drag */
  const phaseY = rect.height - 12;
  pointer(cvHarm, 'pointerdown', rect.width * 0.2, phaseY);
  pointer(cvHarm, 'pointermove', rect.width * 0.3, phaseY - 6);
  pointer(cvHarm, 'pointerup', rect.width * 0.3, phaseY - 6);
  flushFrames(1);
  ok(SG.Store.state.harmonics.overrides.phase.length > 0, 'phase overrides written');
  ok(SG.Store.state.harmonics.overrides.phase.every((o) => o.v >= 0 && o.v < 1), 'phase in turns 0..1');

  /* alt-click hands a harmonic back to the rules */
  const targetN = ov[0].n;
  pointer(cvHarm, 'pointerdown', 26 + (rect.width - 36) * ((targetN - 0.5) / 16), ampY, { altKey: true });
  flushFrames(1);
  ok(SG.Harmonics.getOverride(SG.Store.state.harmonics.overrides.amp, targetN) === null, 'override cleared for n=' + targetN);

  /* hover readout */
  pointer(cvHarm, 'pointermove', rect.width * 0.6, ampY);
  ok(document.getElementById('harm-info').textContent.length > 5, 'hover chip updated');
  SG.UI.harmEditor.render();
});

check('harmonic count wheel changes the spectrum size', () => {
  resetPatch();
  const before = SG.Store.state.harmonics.count;
  let scrolled = cvHarm.dispatchEvent({ type: 'wheel', deltaY: -1, clientX: 10, clientY: 10, shiftKey: false, ctrlKey: false, metaKey: false, preventDefault() {} });
  flushFrames(1);
  ok(SG.Store.state.harmonics.count === before, 'plain wheel leaves the count alone (no scroll trap)');
  cvHarm.dispatchEvent({ type: 'wheel', deltaY: -1, clientX: 10, clientY: 10, shiftKey: false, ctrlKey: true, metaKey: false, preventDefault() {} });
  flushFrames(1);
  ok(SG.Store.state.harmonics.count === before + 1, 'ctrl+wheel grows the count: ' + before + ' → ' + SG.Store.state.harmonics.count);
  cvHarm.dispatchEvent({ type: 'wheel', deltaY: 120, clientX: 10, clientY: 10, shiftKey: true, ctrlKey: true, preventDefault() {} });
  flushFrames(1);
  ok(SG.Store.state.harmonics.count === before - 7, 'ctrl+shift+wheel steps by 8: ' + SG.Store.state.harmonics.count);
});

check('envelope: click adds a point, drag moves it, dblclick removes it', () => {
  resetPatch();
  const rect = cvEnv.getBoundingClientRect();
  const before = SG.Store.state.envelopes.amp.points.length;
  pointer(cvEnv, 'pointerdown', rect.width * 0.62, rect.height * 0.3);
  flushFrames(1);
  const pts = SG.Store.state.envelopes.amp.points;
  ok(pts.length === before + 1, 'point added (' + before + ' → ' + pts.length + ')');
  const idx = pts.length - 2;
  ok(SG.UI.envEditor.selected >= 0, 'new point selected');
  pointer(cvEnv, 'pointermove', rect.width * 0.7, rect.height * 0.15);
  pointer(cvEnv, 'pointerup', rect.width * 0.7, rect.height * 0.15);
  flushFrames(1);
  ok(SG.Store.state.envelopes.amp.points[idx].t > 0.5, 'point moved right: ' + SG.Store.state.envelopes.amp.points[idx].t);
  ok(SG.Store.state.envelopes.amp.points.every((p, i, a) => i === 0 || p.t > a[i - 1].t), 'still sorted');
  SG.UI.envEditor.render();

  pointer(cvEnv, 'dblclick', rect.width * 0.7, rect.height * 0.15);
  flushFrames(1);
  ok(SG.Store.state.envelopes.amp.points.length === before, 'point removed by double-click');
});

check('envelope: curvature handle bends the segment', () => {
  resetPatch();
  SG.Store.update((s) => { s.envelopes.amp.points = [{ t: 0, v: 0, c: 0, hold: false }, { t: 1, v: 1, c: 0, hold: false }]; });
  const rect = cvEnv.getBoundingClientRect();
  const plotL = 40, plotR = rect.width - 14, plotT = 14, plotB = rect.height - 22;
  const hx = plotL + (plotR - plotL) * 0.5;
  const hy = plotT + (plotB - plotT) * 0.5;         /* midpoint of a 0→1 ramp */
  pointer(cvEnv, 'pointerdown', hx, hy);
  ok(SG.UI.envEditor.dragMode === 'curve', 'grabbed the curvature handle, mode=' + SG.UI.envEditor.dragMode);
  pointer(cvEnv, 'pointermove', hx, hy + (plotB - plotT) * 0.3);
  pointer(cvEnv, 'pointerup', hx, hy + (plotB - plotT) * 0.3);
  flushFrames(1);
  const c = SG.Store.state.envelopes.amp.points[0].c;
  ok(c > 0.05, 'curvature increased: ' + c);
  near(SG.Envelope.at(SG.Store.state.envelopes.amp, 0.5), 0.5 - 0.3, 0.06, 'curve passes near the handle');
  SG.UI.envEditor.render();
});

check('envelope: hold toggles and endpoints are protected', () => {
  resetPatch();
  SG.Store.update((s) => { s.envelopes.amp.points = [{ t: 0, v: 0, c: 0, hold: false }, { t: 0.5, v: 1, c: 0, hold: false }, { t: 1, v: 0, c: 0, hold: false }]; });
  const rect = cvEnv.getBoundingClientRect();
  SG.UI.envEditor.selected = 1;
  SG.UI.envEditor.toggleHold(1);
  flushFrames(1);
  ok(SG.Store.state.envelopes.amp.points[1].hold === true, 'hold on');
  SG.UI.envEditor.toggleHold(1);
  ok(SG.Store.state.envelopes.amp.points[1].hold === false, 'hold off');

  const plotT = 14, plotB = rect.height - 22;
  pointer(cvEnv, 'pointerdown', 45, plotT + (plotB - plotT) * 0.9);
  pointer(cvEnv, 'pointermove', rect.width * 0.4, plotT);
  pointer(cvEnv, 'pointerup', rect.width * 0.4, plotT);
  flushFrames(1);
  ok(SG.Store.state.envelopes.amp.points[0].t === 0, 'first point stays at t=0');
  ok(SG.Store.state.envelopes.amp.points[SG.Store.state.envelopes.amp.points.length - 1].t === 1, 'last point stays at t=1');
  ok(SG.UI.envEditor.removePoint(0) === false, 'first point cannot be deleted');
});

check('envelope: keyboard nudging and delete', () => {
  resetPatch();
  SG.UI.envEditor.selected = 2;
  const before = SG.Store.state.envelopes.amp.points[2].v;
  cvEnv.dispatchEvent({ type: 'keydown', key: 'ArrowUp', shiftKey: false, preventDefault() {}, stopPropagation() {} });
  flushFrames(1);
  ok(SG.Store.state.envelopes.amp.points[2].v > before, 'arrow up raised the value: ' + before + ' → ' + SG.Store.state.envelopes.amp.points[2].v);
  cvEnv.dispatchEvent({ type: 'keydown', key: 'ArrowLeft', shiftKey: false, preventDefault() {}, stopPropagation() {} });
  const countBefore = SG.Store.state.envelopes.amp.points.length;
  cvEnv.dispatchEvent({ type: 'keydown', key: 'Delete', preventDefault() {}, stopPropagation() {} });
  flushFrames(1);
  ok(SG.Store.state.envelopes.amp.points.length === countBefore - 1, 'delete removed the point');
});

check('envelope shape buttons replace the curve', () => {
  resetPatch();
  const buttons = document.getElementById('env-shapes').children;
  for (const b of buttons) {
    b.click();
    flushFrames(1);
    const env = SG.Store.state.envelopes.amp;
    ok(env.points.length >= 2, b.textContent + ': valid envelope');
    ok(env.points[0].t === 0 && env.points[env.points.length - 1].t === 1, b.textContent + ': ends pinned');
    SG.UI.envEditor.render();
  }
});

check('modulation envelopes can be enabled with depth', () => {
  resetPatch();
  for (const tab of ['pitch', 'filter']) {
    document.getElementById('env-tabs').children.find((c) => c.getAttribute('data-env') === tab).click();
    flushFrames(1);
    const enable = document.getElementById('env-mod-enable');
    ok(!!enable, tab + ': enable checkbox built');
    enable.checked = true;
    enable.dispatchEvent({ type: 'change', target: enable });
    flushFrames(1);
    ok(SG.Store.state.envelopes[tab].enabled === true, tab + ' enabled');
    const depth = document.getElementById('env-mod-depth');
    ok(!!depth, tab + ': depth slider built');
    depth.value = String(parseFloat(depth.value) * 0.5);
    depth.dispatchEvent({ type: 'input', target: depth });
    depth.dispatchEvent({ type: 'change', target: depth });
    flushFrames(1);
    ok(SG.Store.state.envelopes[tab].depth > 0, tab + ' depth applied');
    SG.UI.envEditor.render();
  }
  document.getElementById('env-tabs').children[0].click();
});

/* ====================================================================== */
section('8 · rule stack UI');

check('add / edit / duplicate / reorder / delete rules', () => {
  resetPatch();
  const start = SG.Store.state.harmonics.rules.length;
  document.getElementById('btn-add-rule').click();
  flushFrames(1);
  ok(SG.Store.state.harmonics.rules.length === start + 1, 'rule added');
  ok(document.getElementById('rule-list').children.length === start + 1, 'row rendered');

  const rows = document.getElementById('rule-list').children;
  const exprInput = rows[rows.length - 1].querySelector('.rule__expr');
  exprInput.value = 'mod(n, 5, 0) ? 1 : 0.1';
  exprInput.dispatchEvent({ type: 'input', target: exprInput });
  flushFrames(1);
  ok(SG.Store.state.harmonics.rules[start].amp === 'mod(n, 5, 0) ? 1 : 0.1', 'expression stored');
  const sp = SG.Harmonics.computeSpectrum(SG.Store.state, U.midiToFreq(60), 44100);
  ok(sp.errors.length === 0, 'new rule evaluates');

  const dupBtn = rows[rows.length - 1].querySelector('.rule__dup');
  dupBtn.click();
  flushFrames(1);
  ok(SG.Store.state.harmonics.rules.length === start + 2, 'duplicated');

  const upBtn = document.getElementById('rule-list').children[start + 1].querySelector('.rule__up');
  const beforeOrder = SG.Store.state.harmonics.rules.map((r) => r.id).join(',');
  upBtn.click();
  flushFrames(1);
  ok(SG.Store.state.harmonics.rules.map((r) => r.id).join(',') !== beforeOrder, 'reordered');

  const delBtn = document.getElementById('rule-list').children[start + 1].querySelector('.rule__del');
  delBtn.click();
  flushFrames(1);
  ok(SG.Store.state.harmonics.rules.length === start + 1, 'deleted one');
});

check('broken expressions surface in the UI without crashing', () => {
  resetPatch();
  SG.Store.update((s) => { s.harmonics.rules[0].amp = '???bad syntax'; });
  flushFrames(1);
  const row = document.getElementById('rule-list').children[0];
  ok(row.classList.contains('has-error'), 'row flagged');
  ok(row.querySelector('.rule__err').textContent.length > 0, 'message shown: ' + row.querySelector('.rule__err').textContent);
  SG.Store.update((s) => { s.harmonics.rules[0].amp = '1/n'; });
  flushFrames(1);
  ok(!document.getElementById('rule-list').children[0].classList.contains('has-error'), 'error cleared');
});

check('recipes load into rule 1', () => {
  resetPatch();
  const buttons = document.getElementById('expr-ref').querySelectorAll('.btn');
  ok(buttons.length === SG.Harmonics.RECIPES.length, 'recipe buttons rendered: ' + buttons.length);
  for (const b of buttons) {
    b.click();
    flushFrames(1);
    const sp = SG.Harmonics.computeSpectrum(SG.Store.state, U.midiToFreq(SG.Store.state.note.midi), SG.Store.state.sample.sampleRate);
    ok(sp.errors.length === 0, b.textContent + ': ' + JSON.stringify(sp.errors));
    SG.UI.waveEditor.render();
    SG.UI.harmEditor.render();
  }
});

check('waveform preset buttons load rule stacks', () => {
  for (const b of document.getElementById('wave-presets').children) {
    resetPatch();
    b.click();
    flushFrames(1);
    const st = SG.Store.state;
    ok(st.harmonics.overrides.amp.length === 0, b.textContent + ': overrides cleared');
    const sp = SG.Harmonics.computeSpectrum(st, U.midiToFreq(st.note.midi), st.sample.sampleRate);
    ok(sp.errors.length === 0, b.textContent + ': ' + JSON.stringify(sp.errors));
    ok(sp.activeCount > 0, b.textContent + ': audible');
  }
});

check('factory presets load from the select', () => {
  const sel = document.getElementById('sel-preset');
  const options = sel.querySelectorAll('option').filter((o) => o.getAttribute('value'));
  ok(options.length === SG.Presets.PATCHES.length, 'preset options: ' + options.length);
  for (const o of options) {
    sel.value = o.getAttribute('value');
    sel.dispatchEvent({ type: 'change', target: sel });
    flushFrames(2);
    ok(SG.Store.state.harmonics.rules.length >= 1, o.textContent + ': rules present');
    const sp = SG.Harmonics.computeSpectrum(SG.Store.state, U.midiToFreq(SG.Store.state.note.midi), SG.Store.state.sample.sampleRate);
    ok(sp.errors.length === 0, o.textContent + ': ' + JSON.stringify(sp.errors));
    SG.UI.waveEditor.render();
    SG.UI.harmEditor.render();
    SG.UI.envEditor.render();
  }
  resetPatch();
});

/* ====================================================================== */
section('9 · controls, keyboard, export');

check('panel controls write to the state', () => {
  resetPatch();
  const set = (id, value, event = 'change') => {
    const el = document.getElementById(id);
    ok(!!el, 'control #' + id + ' exists');
    if (el.getAttribute && el.getAttribute('type') === 'checkbox') el.checked = !!value;
    else el.value = String(value);
    el.dispatchEvent({ type: 'input', target: el });
    el.dispatchEvent({ type: event, target: el });
    flushFrames(1);
  };
  set('rng-count', 48); ok(SG.Store.state.harmonics.count === 48, 'harmonic count');
  set('sel-normalize', 'rms'); ok(SG.Store.state.harmonics.normalize === 'rms', 'normalise mode');
  set('sel-phasebase', 'alt'); ok(SG.Store.state.harmonics.phaseBase === 'alt', 'phase base');
  set('num-seed', 99); ok(SG.Store.state.harmonics.seed === 99, 'seed');
  set('chk-aa', false); ok(SG.Store.state.harmonics.antiAlias === false, 'anti-alias');
  set('chk-phase', false); ok(SG.Store.state.ui.showPhase === false, 'phase lane');
  set('rng-volume', 0.35); near(SG.Store.state.transport.volume, 0.35, 1e-9, 'volume');
  set('rng-unison', 3); ok(SG.Store.state.voice.unison === 3, 'unison');
  set('rng-spread', 30); near(SG.Store.state.voice.spread, 30, 1e-9, 'spread');
  set('chk-stereo', false); ok(SG.Store.state.voice.stereo === false, 'stereo');
  set('chk-filter', true); ok(SG.Store.state.filter.enabled === true, 'filter on');
  set('sel-filter-type', 'highpass'); ok(SG.Store.state.filter.type === 'highpass', 'filter type');
  set('rng-q', 7.5); near(SG.Store.state.filter.q, 7.5, 1e-9, 'Q');
  set('rng-cutoff', 0.5); ok(SG.Store.state.filter.cutoff > 100 && SG.Store.state.filter.cutoff < 1000, 'cutoff mapped: ' + SG.Store.state.filter.cutoff);
  set('num-duration', 2.5); near(SG.Store.state.sample.duration, 2.5, 1e-9, 'duration');
  set('sel-samplerate', 48000); ok(SG.Store.state.sample.sampleRate === 48000, 'sample rate');
  set('sel-bitdepth', 24); ok(SG.Store.state.sample.bitDepth === 24, 'bit depth');
  set('chk-mono', true); ok(SG.Store.state.sample.mono === true, 'mono');
  set('chk-normalize-out', false); ok(SG.Store.state.sample.normalize === false, 'normalise off');
  set('rng-peak', 0.5); near(SG.Store.state.sample.peak, 0.5, 1e-9, 'peak target');
  set('num-fadein', 12); near(SG.Store.state.sample.fadeIn, 12, 1e-9, 'fade in');
  set('num-fadeout', 40); near(SG.Store.state.sample.fadeOut, 40, 1e-9, 'fade out');
  set('txt-filename', 'my-sample'); ok(SG.Store.state.sample.filename === 'my-sample', 'filename');
  set('sel-note', 45); ok(SG.Store.state.note.midi === 45, 'note select');
});

check('control values are re-synced from the state', () => {
  resetPatch();
  SG.Store.update((s) => { s.harmonics.count = 13; s.sample.duration = 0.42; s.filter.cutoff = 8000; });
  flushFrames(1);
  SG.UI.syncControls();
  ok(document.getElementById('rng-count').value === '13', 'count slider synced: ' + document.getElementById('rng-count').value);
  ok(document.getElementById('out-count').textContent.indexOf('13') === 0, 'count output synced');
  ok(document.getElementById('num-duration').value === '0.42', 'duration synced: ' + document.getElementById('num-duration').value);
  ok(document.getElementById('out-cutoff').textContent.indexOf('8') === 0, 'cutoff readout synced: ' + document.getElementById('out-cutoff').textContent);
});

check('on-screen keyboard triggers notes', () => {
  resetPatch();
  const keys = document.getElementById('keyboard').children;
  ok(keys.length === 25, 'keys rendered');
  const key = keys[7];
  const midi = parseInt(key.getAttribute('data-midi'), 10);
  pointer(key, 'pointerdown', 5, 5);
  flushFrames(1);
  ok(SG.Store.state.note.midi === midi, 'note set to ' + midi);
  ok(SG.Audio.playing === true, 'audio triggered');
  SG.Audio.stop();
});

check('computer keyboard maps to notes and octaves', () => {
  resetPatch();
  const rootBase = SG.Store.state.ui.keyRoot + 12;
  const press = (key, extra = {}) => window.dispatchEvent(Object.assign({
    type: 'keydown', key, repeat: false, target: document.body,
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, preventDefault() {}
  }, extra));
  press('a');
  flushFrames(1);
  ok(SG.Store.state.note.midi === rootBase, 'A → base note ' + rootBase + ', got ' + SG.Store.state.note.midi);
  press('w');
  flushFrames(1);
  ok(SG.Store.state.note.midi === rootBase + 1, 'W → +1 semitone');
  press('z');
  ok(SG.Store.state.ui.keyRoot === 36, 'Z shifts the octave down: ' + SG.Store.state.ui.keyRoot);
  press('x');
  ok(SG.Store.state.ui.keyRoot === 48, 'X shifts the octave up');
  SG.Audio.stop();
  press(' ');
  flushFrames(1);
  ok(SG.Audio.playing === true, 'space plays');
  press(' ');
  ok(SG.Audio.playing === false, 'space toggles off');
  press(' ');
  ok(SG.Audio.playing === true, 'space plays again');
  press('escape');
  ok(SG.Audio.playing === false, 'escape stops');
  SG.Audio.stop();
});

await checkAsync('preview render fills the output view and meters', async () => {
  resetPatch();
  SG.UI.requestPreview();
  await new Promise((r) => setTimeout(r, 600));
  flushFrames(2);
  const meters = document.getElementById('out-meters').children;
  ok(meters.length >= 6, 'meter chips: ' + meters.length);
  const text = meters.map((m) => m.textContent).join(' | ');
  ok(/peak/.test(text), 'peak meter present: ' + text);
  ok(/kHz/.test(text), 'sample rate meter present');
  SG.UI.drawOutput();
});

await checkAsync('WAV export produces a file with the patch settings', async () => {
  resetPatch();
  SG.Store.update((s) => { s.sample.bitDepth = 24; s.sample.duration = 0.5; s.sample.filename = 'test-export'; });
  lastDownload = null;
  SG.UI.exportWav();
  await new Promise((r) => setTimeout(r, 400));
  ok(lastDownload, 'download started');
  const dv = new DataView(await lastDownload.arrayBuffer());
  const expectedFrames = Math.ceil((0.5 + SG.Store.state.sample.tail) * 44100);
  const channels = SG.Store.state.sample.mono ? 1 : 2;
  ok(dv.getUint16(20, true) === 1, 'PCM');
  ok(dv.getUint16(34, true) === 24, 'bit depth honoured');
  ok(dv.getUint16(22, true) === channels, 'channel count honoured');
  ok(Math.abs(dv.getUint32(40, true) - expectedFrames * 3 * channels) <= 3 * channels,
    'data size ' + dv.getUint32(40, true) + ' ≈ ' + expectedFrames * 3 * channels);
  const toastText = document.getElementById('toast').textContent;
  ok(/Exported/.test(toastText), 'toast confirms export: ' + toastText);
  ok(/\.wav/.test(toastText), 'filename in toast');
});

await checkAsync('save / load JSON round-trips through the UI', async () => {
  resetPatch();
  SG.Store.update((s) => { s.harmonics.count = 41; s.note.midi = 55; s.sample.duration = 1.75; });
  lastDownload = null;
  SG.UI.saveJSON();
  ok(lastDownload, 'json download started');
  const text = await lastDownload.text();
  const parsed = JSON.parse(text);
  ok(parsed.harmonics.count === 41 && parsed.note.midi === 55, 'json content');
  resetPatch();
  ok(SG.Store.state.harmonics.count === 24, 'reset applied');
  const file = { name: 'patch.json', text: async () => text };
  SG.UI.loadJSON(file);
  await new Promise((r) => setTimeout(r, 50));
  flushFrames(2);
  ok(SG.Store.state.harmonics.count === 41, 'patch reloaded from file');
  ok(SG.Store.state.note.midi === 55, 'note reloaded');
});

check('undo/redo buttons and shortcuts work', () => {
  resetPatch();
  SG.Store.update((s) => { s.harmonics.count = 60; });
  flushFrames(1);
  document.getElementById('btn-undo').click();
  flushFrames(1);
  ok(SG.Store.state.harmonics.count === 24, 'undo button');
  document.getElementById('btn-redo').click();
  flushFrames(1);
  ok(SG.Store.state.harmonics.count === 60, 'redo button');
  window.dispatchEvent({ type: 'keydown', key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, target: document.body, preventDefault() {} });
  flushFrames(1);
  ok(SG.Store.state.harmonics.count === 24, 'ctrl+z');
  window.dispatchEvent({ type: 'keydown', key: 'z', ctrlKey: true, metaKey: false, shiftKey: true, target: document.body, preventDefault() {} });
  flushFrames(1);
  ok(SG.Store.state.harmonics.count === 60, 'ctrl+shift+z');
});

check('share link round-trips through the UI', () => {
  resetPatch();
  SG.Store.update((s) => { s.harmonics.count = 29; s.harmonics.rules[0].amp = 'isFib(n) ? 1 : 0'; });
  SG.UI.copyLink();
  const hash = SG.Store.toHash();
  resetPatch();
  ok(SG.Store.state.harmonics.count === 24, 'reset');
  globalThis.location.hash = hash;
  ok(SG.Store.fromHash(hash), 'hash read back');
  ok(SG.Store.state.harmonics.count === 29, 'count restored from hash');
  ok(SG.Store.state.harmonics.rules[0].amp === 'isFib(n) ? 1 : 0', 'rule restored from hash');
});

/* ====================================================================== */
section('10 · stress');

await checkAsync('extreme patches stay finite and quiet-safe', async () => {
  const cases = [
    { name: 'max harmonics', patch: { harmonics: { count: 128, rules: [{ id: 'r', enabled: true, amp: 'rand(n)*2', mode: 'set', amount: 2 }] } } },
    { name: 'tiny sample', patch: { sample: { duration: 0.01 }, harmonics: { count: 4 } } },
    { name: 'long sample', patch: { sample: { duration: 10 }, envelopes: { amp: { points: [{ t: 0, v: 1, c: 0, hold: false }, { t: 1, v: 1, c: 0, hold: false }] } } } },
    { name: 'high note + many harmonics', patch: { note: { midi: 108 }, harmonics: { count: 64, rules: [{ id: 'r', enabled: true, amp: '1', mode: 'set', amount: 1 }] } } },
    { name: 'all zero spectrum', patch: { harmonics: { count: 16, rules: [{ id: 'r', enabled: true, amp: '0', mode: 'set', amount: 1 }] } } },
    { name: 'huge amplitudes', patch: { harmonics: { count: 32, normalize: 'none', rules: [{ id: 'r', enabled: true, amp: '1000', mode: 'set', amount: 1000 }] } } },
    { name: 'filter fully open + Q max', patch: { filter: { enabled: true, type: 'lowpass', cutoff: 20000, q: 20 } } },
    { name: 'pitch env max depth', patch: { envelopes: { pitch: { enabled: true, depth: 48, points: [{ t: 0, v: 1, c: 0, hold: false }, { t: 1, v: -1, c: 0, hold: false }] } } } }
  ];
  for (const c of cases) {
    const state = SG.Store.sanitize(U.mergeDeep(SG.Store.defaults(), c.patch));
    const sp = SG.Harmonics.computeSpectrum(state, U.midiToFreq(state.note.midi), state.sample.sampleRate);
    for (let n = 1; n <= sp.N; n++) {
      ok(isFinite(sp.amp[n]) && isFinite(sp.phase[n]), c.name + ': finite harmonic ' + n);
      ok(sp.amp[n] >= 0, c.name + ': non-negative amp');
    }
    ok(isFinite(sp.wavePeak), c.name + ': finite peak ' + sp.wavePeak);
    const buffer = await SG.Audio.renderOffline(state, state.note.midi);
    const stats = SG.Wav.stats(buffer);
    ok(isFinite(stats.peak), c.name + ': render finite');
    ok(stats.peak <= 1.0001, c.name + ': render within full scale (' + stats.peak + ')');
    SG.Wav.encode(buffer, state.sample.bitDepth);
  }
});

check('rapid drawing does not corrupt state', () => {
  resetPatch();
  const rect = cvWave.getBoundingClientRect();
  for (let round = 0; round < 6; round++) {
    pointer(cvWave, 'pointerdown', 20, rect.height / 2);
    for (let x = 20; x < rect.width - 10; x += 7) {
      pointer(cvWave, 'pointermove', x, rect.height / 2 + Math.sin(x * 0.2 + round) * rect.height * 0.45);
    }
    pointer(cvWave, 'pointerup', rect.width - 10, rect.height / 2);
    flushFrames(1);
  }
  const st = SG.Store.state;
  ok(st.harmonics.overrides.amp.length === st.harmonics.count, 'override count stable');
  ok(st.harmonics.overrides.amp.every((o) => o.n >= 1 && o.n <= st.harmonics.count && isFinite(o.v) && o.v >= 0 && o.v <= 1.0001), 'override values legal');
  ok(st.envelopes.amp.points.length >= 2, 'envelope intact');
  SG.UI.waveEditor.render();
  SG.UI.harmEditor.render();
});

check('audio graph is built without automation conflicts', () => {
  const relevant = audioProblems.filter((p) => p.kind === 'overlap' || p.kind === 'wave' || p.kind === 'curve');
  if (relevant.length) throw new Error(relevant.length + ' Web Audio problems:\n' + relevant.slice(0, 8).map((p) => '   ' + p.kind + ': ' + p.message).join('\n'));
  ok(true, 'no overlapping automation, no bad periodic waves, no bad curves');
});

check('all recorded Web Audio problems', () => {
  if (audioProblems.length) {
    throw new Error(audioProblems.length + ' problems:\n' + audioProblems.slice(0, 10).map((p) => '   ' + p.kind + ': ' + p.message).join('\n'));
  }
  ok(true, 'clean');
});

/* ------------------------------------------------------------- summary */
console.log('\n' + '─'.repeat(64));
if (failures.length) {
  console.log('FAILED ' + failures.length + ' / ' + (pass + failures.length));
  for (const [name, err] of failures) console.log('\n✗ ' + name + '\n' + (err.stack || err.message));
  process.exit(1);
} else {
  console.log('All ' + pass + ' checks passed.');
  process.exit(0);
}
