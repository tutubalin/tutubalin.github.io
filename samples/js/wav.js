/* ==========================================================================
   SampleForge — js/wav.js
   Minimal RIFF/WAVE writer: 16-bit PCM, 24-bit PCM and 32-bit float.
   ========================================================================== */
(function (root) {
  'use strict';

  var SG = (root.SG = root.SG || {});
  var W = (SG.Wav = {});

  function writeString(view, offset, str) {
    for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  /* Accepts an AudioBuffer or { channels: [Float32Array], sampleRate }. */
  W.encode = function (audioBuffer, bitDepth) {
    var channels = [], sampleRate;
    if (audioBuffer && typeof audioBuffer.getChannelData === 'function') {
      sampleRate = audioBuffer.sampleRate;
      for (var c = 0; c < audioBuffer.numberOfChannels; c++) channels.push(audioBuffer.getChannelData(c));
    } else {
      channels = audioBuffer.channels || [];
      sampleRate = audioBuffer.sampleRate || 44100;
    }

    bitDepth = bitDepth === 24 ? 24 : (bitDepth === 32 ? 32 : 16);
    var numCh = Math.max(1, channels.length);
    var numFrames = channels[0] ? channels[0].length : 0;
    var bytesPerSample = bitDepth / 8;
    var blockAlign = numCh * bytesPerSample;
    var byteRate = Math.round(sampleRate * blockAlign);
    var dataSize = numFrames * blockAlign;
    var isFloat = bitDepth === 32;
    var fmtSize = isFloat ? 18 : 16;
    var headerSize = 28 + fmtSize;                 /* 44 bytes for plain PCM */

    var buffer = new ArrayBuffer(headerSize + dataSize);
    var view = new DataView(buffer);
    var p = 0;

    writeString(view, p, 'RIFF'); p += 4;
    view.setUint32(p, 20 + fmtSize + dataSize, true); p += 4;
    writeString(view, p, 'WAVE'); p += 4;

    writeString(view, p, 'fmt '); p += 4;
    view.setUint32(p, fmtSize, true); p += 4;
    view.setUint16(p, isFloat ? 3 : 1, true); p += 2;          /* 3 = IEEE float */
    view.setUint16(p, numCh, true); p += 2;
    view.setUint32(p, sampleRate, true); p += 4;
    view.setUint32(p, byteRate, true); p += 4;
    view.setUint16(p, blockAlign, true); p += 2;
    view.setUint16(p, bitDepth, true); p += 2;
    if (isFloat) { view.setUint16(p, 0, true); p += 2; }       /* cbSize */

    writeString(view, p, 'data'); p += 4;
    view.setUint32(p, dataSize, true); p += 4;

    for (var i = 0; i < numFrames; i++) {
      for (var ch = 0; ch < numCh; ch++) {
        var s = channels[ch] ? channels[ch][i] : 0;
        if (!(s >= -1 && s <= 1)) s = s < 0 ? -1 : (s > 0 ? 1 : 0);   /* clamp + NaN guard */
        if (bitDepth === 16) {
          view.setInt16(p, Math.max(-32768, Math.min(32767, Math.round(s * (s < 0 ? 32768 : 32767)))), true);
          p += 2;
        } else if (bitDepth === 24) {
          var v = Math.max(-8388608, Math.min(8388607, Math.round(s * (s < 0 ? 8388608 : 8388607))));
          view.setUint8(p, v & 0xff);
          view.setUint8(p + 1, (v >> 8) & 0xff);
          view.setUint8(p + 2, (v >> 16) & 0xff);
          p += 3;
        } else {
          view.setFloat32(p, s, true);
          p += 4;
        }
      }
    }

    return new Blob([view], { type: 'audio/wav' });
  };

  /* Statistics used by the output panel. */
  W.stats = function (audioBuffer) {
    var peak = 0, sumSq = 0, dc = 0, n = 0, clipped = 0;
    for (var c = 0; c < audioBuffer.numberOfChannels; c++) {
      var d = audioBuffer.getChannelData(c);
      for (var i = 0; i < d.length; i++) {
        var v = d[i];
        var a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        if (a >= 0.99999) clipped++;
        sumSq += v * v; dc += v; n++;
      }
    }
    return {
      peak: peak,
      rms: n ? Math.sqrt(sumSq / n) : 0,
      dc: n ? dc / n : 0,
      clipped: clipped,
      frames: audioBuffer.length,
      duration: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
      channels: audioBuffer.numberOfChannels
    };
  };

})(typeof window !== 'undefined' ? window : globalThis);
