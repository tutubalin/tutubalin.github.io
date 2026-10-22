/* ==========================================================================
   tools/shim/audio.mjs — Web Audio shim for the Node smoke test.
   It validates the things a real browser would reject (non-finite values,
   overlapping automation events, mismatched PeriodicWave arrays) and records
   them so the test can assert the app never triggers them.
   The offline "render" produces a synthetic signal — audio correctness itself
   is the browser's job, this shim checks our plumbing.
   ========================================================================== */

export const problems = [];

function flag(kind, message) {
  problems.push({ kind, message });
}

class AudioParamShim {
  constructor(name, value, ctx) {
    this.name = name;
    this._value = value;
    this.defaultValue = value;
    this.minValue = -3.4e38;
    this.maxValue = 3.4e38;
    this.ctx = ctx;
    this.events = [];
  }
  get value() { return this._value; }
  set value(v) {
    if (!isFinite(v)) flag('param-value', `${this.name}: non-finite value ${v}`);
    this._value = v;
  }
  _checkFinite(v, method) {
    if (!isFinite(v)) flag('param-value', `${this.name}.${method}: non-finite value ${v}`);
  }
  _range(start, end, method) {
    if (!(end > start)) flag('automation', `${this.name}.${method}: non-positive duration`);
    for (const ev of this.events) {
      const evEnd = ev.end === undefined ? ev.time : ev.end;
      const overlap = start < evEnd - 1e-9 && end > ev.time + 1e-9;
      if (overlap) {
        const err = new Error(`Failed to execute '${method}' on 'AudioParam': overlapping automation ` +
          `[${start.toFixed(4)}..${end.toFixed(4)}] vs ${ev.method} [${ev.time.toFixed(4)}..${evEnd.toFixed(4)}]`);
        flag('overlap', `${this.name}: ${err.message}`);
        throw err;
      }
    }
  }
  setValueAtTime(value, time) {
    this._checkFinite(value, 'setValueAtTime');
    if (!isFinite(time) || time < 0) flag('automation', `${this.name}.setValueAtTime: bad time ${time}`);
    this._range(time, time + 1e-9, 'setValueAtTime');
    this.events.push({ method: 'setValueAtTime', time, end: time, value });
    this._value = value;
    return this;
  }
  linearRampToValueAtTime(value, time) {
    this._checkFinite(value, 'linearRampToValueAtTime');
    this.events.push({ method: 'linearRamp', time, end: time, value });
    return this;
  }
  exponentialRampToValueAtTime(value, time) {
    if (value === 0) flag('automation', `${this.name}.exponentialRampToValueAtTime: target 0 (throws in browsers)`);
    this.events.push({ method: 'expRamp', time, end: time, value });
    return this;
  }
  setTargetAtTime(value, time, constant) {
    this._checkFinite(value, 'setTargetAtTime');
    if (!(constant > 0)) flag('automation', `${this.name}.setTargetAtTime: bad time constant ${constant}`);
    this.events.push({ method: 'setTarget', time, end: time + constant * 5, value });
    return this;
  }
  setValueCurveAtTime(values, start, duration) {
    if (!(values && values.length >= 2)) flag('curve', `${this.name}.setValueCurveAtTime: curve length ${values ? values.length : 'none'} (< 2)`);
    if (!(duration > 0)) flag('curve', `${this.name}.setValueCurveAtTime: non-positive duration ${duration}`);
    for (let i = 0; i < values.length; i++) {
      if (!isFinite(values[i])) { flag('curve', `${this.name}.setValueCurveAtTime: non-finite value at ${i}`); break; }
    }
    this._range(start, start + duration, 'setValueCurveAtTime');
    this.events.push({ method: 'curve', time: start, end: start + duration, values: Float32Array.from(values), duration });
    return this;
  }
  cancelScheduledValues(t) { this.events = this.events.filter((e) => e.time < t); return this; }
  cancelAndHoldAtTime(t) { return this.cancelScheduledValues(t); }
  /* value at a given context time, mirroring curve + hold behaviour */
  valueAt(time) {
    let v = this._value;
    for (const ev of this.events) {
      if (ev.method === 'curve') {
        if (time >= ev.time && time <= ev.end) {
          const x = (time - ev.time) / (ev.end - ev.time || 1);
          const idx = Math.min(ev.values.length - 1, Math.max(0, Math.round(x * (ev.values.length - 1))));
          return ev.values[idx];
        }
        if (time > ev.end) v = ev.values[ev.values.length - 1];
      } else if (ev.time <= time) {
        v = ev.value;
      }
    }
    return v;
  }
}

class AudioNodeShim {
  constructor(ctx, kind) {
    this.context = ctx;
    this.kind = kind;
    this.numberOfInputs = 1;
    this.numberOfOutputs = 1;
    this.channelCount = 2;
    this.connections = [];
    ctx._nodes.push(this);
  }
  connect(dest) {
    if (!dest) flag('graph', `${this.kind}.connect(undefined)`);
    this.connections.push(dest);
    return dest && dest instanceof AudioNodeShim ? dest : undefined;
  }
  disconnect() { this.connections = []; }
}

class GainNodeShim extends AudioNodeShim {
  constructor(ctx) { super(ctx, 'gain'); this.gain = new AudioParamShim('gain', 1, ctx); }
}
class ConstantSourceShim extends AudioNodeShim {
  constructor(ctx) { super(ctx, 'constant'); this.offset = new AudioParamShim('offset', 1, ctx); }
}
class StereoPannerShim extends AudioNodeShim {
  constructor(ctx) { super(ctx, 'panner'); this.pan = new AudioParamShim('pan', 0, ctx); }
}
class BiquadFilterShim extends AudioNodeShim {
  constructor(ctx) {
    super(ctx, 'biquad');
    this._type = 'lowpass';
    this.frequency = new AudioParamShim('frequency', 350, ctx);
    this.Q = new AudioParamShim('Q', 1, ctx);
    this.gain = new AudioParamShim('biquadGain', 0, ctx);
    this.detune = new AudioParamShim('detune', 0, ctx);
  }
  get type() { return this._type; }
  set type(v) {
    const ok = ['lowpass', 'highpass', 'bandpass', 'lowshelf', 'highpass', 'highshelf', 'peaking', 'notch', 'allpass'];
    if (ok.indexOf(v) < 0) flag('graph', `BiquadFilterNode: unknown type "${v}"`);
    this._type = v;
  }
  getFrequencyResponse() {}
}
class AnalyserShim extends AudioNodeShim {
  constructor(ctx) {
    super(ctx, 'analyser');
    this.fftSize = 2048;
    this.smoothingTimeConstant = 0.8;
    this.frequencyBinCount = 1024;
  }
  getFloatTimeDomainData(arr) {
    for (let i = 0; i < arr.length; i++) arr[i] = 0.2 * Math.sin(i * 0.05);
  }
  getByteFrequencyData(arr) { for (let i = 0; i < arr.length; i++) arr[i] = 64; }
}
class OscillatorShim extends AudioNodeShim {
  constructor(ctx) {
    super(ctx, 'oscillator');
    this.frequency = new AudioParamShim('frequency', 440, ctx);
    this.detune = new AudioParamShim('detune', 0, ctx);
    this._type = 'sine';
    this.wave = null;
    this.started = null;
    this.stopped = null;
    this.onended = null;
  }
  get type() { return this._type; }
  set type(v) {
    if (['sine', 'square', 'sawtooth', 'triangle', 'custom'].indexOf(v) < 0) flag('graph', `OscillatorNode: bad type ${v}`);
    this._type = v;
  }
  setPeriodicWave(wave) {
    if (!wave || wave.kind !== 'periodic') flag('graph', 'setPeriodicWave: not a PeriodicWave');
    this.wave = wave;
    this._type = 'custom';
  }
  start(when) {
    if (this.started !== null) flag('graph', 'OscillatorNode.start called twice');
    if (when !== undefined && (!isFinite(when) || when < 0)) flag('graph', `OscillatorNode.start: bad time ${when}`);
    this.started = when === undefined ? this.context.currentTime : when;
  }
  stop(when) {
    if (this.started === null) flag('graph', 'OscillatorNode.stop before start');
    if (when !== undefined && (!isFinite(when) || when < 0)) flag('graph', `OscillatorNode.stop: bad time ${when}`);
    this.stopped = when === undefined ? this.context.currentTime : when;
  }
}

class PeriodicWaveShim {
  constructor(real, imag, ctx) {
    this.kind = 'periodic';
    if (!real || !imag || real.length !== imag.length) {
      flag('wave', `createPeriodicWave: length mismatch (${real && real.length} vs ${imag && imag.length})`);
      throw new Error('createPeriodicWave: length mismatch');
    }
    if (real.length < 2) flag('wave', `createPeriodicWave: too short (${real.length})`);
    for (let i = 0; i < real.length; i++) {
      if (!isFinite(real[i]) || !isFinite(imag[i])) {
        flag('wave', `createPeriodicWave: non-finite coefficient at ${i}`);
        break;
      }
    }
    this.real = Float32Array.from(real);
    this.imag = Float32Array.from(imag);
    this.ctx = ctx;
  }
}

class AudioBufferShim {
  constructor(channels, length, sampleRate, fill) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this._data = [];
    for (let c = 0; c < channels; c++) {
      const d = new Float32Array(length);
      if (fill) fill(d, c);
      this._data.push(d);
    }
  }
  getChannelData(c) { return this._data[c]; }
  copyFromChannel(dest, c) { dest.set(this._data[c]); }
  copyToChannel(src, c) { this._data[c].set(src); }
}

class BaseContext {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.state = 'running';
    this._nodes = [];
    this.destination = new AudioNodeShim(this, 'destination');
    this.destination.numberOfChannels = 2;
    this.destination.maxChannelCount = 2;
  }
  createGain() { return new GainNodeShim(this); }
  createOscillator() { return new OscillatorShim(this); }
  createBiquadFilter() { return new BiquadFilterShim(this); }
  createStereoPanner() { return new StereoPannerShim(this); }
  createAnalyser() { return new AnalyserShim(this); }
  createConstantSource() { return new ConstantSourceShim(this); }
  createBuffer(ch, len, sr) { return new AudioBufferShim(ch, len, sr); }
  createPeriodicWave(real, imag, opts) { return new PeriodicWaveShim(real, imag, this, opts); }
  createBufferSource() { const n = new AudioNodeShim(this, 'buffersource'); n.buffer = null; n.start = () => {}; n.stop = () => {}; return n; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  _advance(dt) { this.currentTime += dt; }
}

export class AudioContextShim extends BaseContext {
  constructor(opts) { super((opts && opts.sampleRate) || 48000); }
}

export class OfflineAudioContextShim extends BaseContext {
  constructor(a, b, c) {
    let channels, length, sampleRate;
    if (typeof a === 'object' && a !== null) { channels = a.numberOfChannels; length = a.length; sampleRate = a.sampleRate; }
    else { channels = a; length = b; sampleRate = c; }
    super(sampleRate);
    if (!(channels >= 1 && channels <= 32)) flag('offline', `bad channel count ${channels}`);
    if (!(length >= 1)) flag('offline', `bad length ${length}`);
    if (!(sampleRate >= 3000 && sampleRate <= 768000)) flag('offline', `bad sample rate ${sampleRate}`);
    this._channels = channels;
    this._length = length;
    this.destination.numberOfChannels = channels;
    this.destination.maxChannelCount = channels;
    this.renderCount = (OfflineAudioContextShim.total = (OfflineAudioContextShim.total || 0) + 1);
  }
  startRendering() {
    /* synthetic signal: a 220 Hz tone with a decaying envelope + a little noise,
       different per channel so stereo handling is visible */
    const fill = (data, ch) => {
      for (let i = 0; i < data.length; i++) {
        const t = i / this.sampleRate;
        const env = Math.exp(-t * 1.6);
        data[i] = env * (0.6 * Math.sin(2 * Math.PI * (220 + ch * 5) * t) + 0.05 * Math.sin(2 * Math.PI * 1330 * t));
      }
      data[data.length - 1] = 0;
    };
    const buffer = new AudioBufferShim(this._channels, this._length, this.sampleRate, fill);
    this.state = 'suspended';
    return Promise.resolve(buffer);
  }
}

export function makeAudioShim() {
  return { AudioContext: AudioContextShim, OfflineAudioContext: OfflineAudioContextShim, problems };
}
