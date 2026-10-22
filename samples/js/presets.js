/* ==========================================================================
   SampleForge — js/presets.js
   Two kinds of presets:
     • WAVEFORMS — one-click starting spectra for the waveform panel. They are
       expressed as harmonic rules (not sample data), which is why the rule
       stack stays editable after picking one.
     • PATCHES   — complete instruments (spectrum + envelopes + filter + voice).
   ========================================================================== */
(function (root) {
  'use strict';

  var SG = (root.SG = root.SG || {});
  var E = SG.Envelope;
  var P = (SG.Presets = {});

  function pts(list) { return E.make(list).points; }
  function rule(amp, opts) {
    var r = { id: SG.util.uid('rule'), enabled: true, amp: amp, mode: 'set', amount: 1, phase: '', phaseMode: 'add' };
    if (opts) for (var k in opts) r[k] = opts[k];
    return r;
  }

  /* ------------------------------------------------------------- waveforms */
  P.WAVEFORMS = [
    { id: 'sine', label: 'Sine', patch: { harmonics: { count: 8, phaseBase: 'zero', rules: [rule('n === 1 ? 1 : 0')] } } },
    { id: 'triangle', label: 'Triangle', patch: { harmonics: { count: 24, phaseBase: 'zero', rules: [rule('odd(n) ? 1/(n*n) : 0', { phase: '0.5*(((n-1)>>1)%2)' })] } } },
    { id: 'square', label: 'Square', patch: { harmonics: { count: 24, phaseBase: 'zero', rules: [rule('odd(n) ? 1/n : 0')] } } },
    { id: 'saw', label: 'Saw', patch: { harmonics: { count: 32, phaseBase: 'zero', rules: [rule('1/n')] } } },
    { id: 'pulse25', label: 'Pulse 25%', patch: { harmonics: { count: 32, phaseBase: 'zero', rules: [rule('pulse(n, 0.25)')] } } },
    { id: 'pulse12', label: 'Pulse 12%', patch: { harmonics: { count: 40, phaseBase: 'zero', rules: [rule('pulse(n, 0.125)')] } } },
    { id: 'even', label: 'Even only', patch: { harmonics: { count: 24, phaseBase: 'zero', rules: [rule('even(n) ? 1 : 0')] } } },
    { id: 'odd', label: 'Odd flat', patch: { harmonics: { count: 24, phaseBase: 'zero', rules: [rule('odd(n) ? 1 : 0')] } } },
    { id: 'third', label: 'Every 3rd', patch: { harmonics: { count: 32, phaseBase: 'zero', rules: [rule('mod(n,3,0) ? 1 : 0.04')] } } },
    { id: 'organ', label: 'Drawbars', patch: { harmonics: { count: 16, phaseBase: 'zero', rules: [rule('n < 9 ? [1, 0, 0.5, 1, 0, 0.35, 0, 0.22][n-1] : 0')] } } },
    { id: 'comb', label: 'Comb', patch: { harmonics: { count: 40, phaseBase: 'zero', rules: [rule('comb(n, 6, 1.1)')] } } },
    { id: 'noise', label: 'Noise', patch: { harmonics: { count: 48, phaseBase: 'rand', rules: [rule('rand(n)', { phase: 'rand(n + 977)' })] } } },
    { id: 'pink', label: 'Pink', patch: { harmonics: { count: 48, phaseBase: 'rand', rules: [rule('pink(n)', { phase: 'rand(n + 31)' })] } } },
    { id: 'bell', label: 'Bell', patch: { harmonics: { count: 32, phaseBase: 'golden', rules: [rule('exp(-n/5) * (0.45 + 0.55*sin(n*1.9))')] } } },
    { id: 'vowelA', label: 'Vowel A', patch: { harmonics: { count: 32, phaseBase: 'zero', rules: [rule('gauss(f,730,90) + 0.55*gauss(f,1090,110) + 0.25*gauss(f,2440,170)')] } } },
    { id: 'subair', label: 'Sub + air', patch: { harmonics: { count: 48, phaseBase: 'zero', rules: [rule('n < 3 ? 1 : 0.04 + 0.96*smoothstep(N*0.62, N, n)')] } } }
  ];

  /* ---------------------------------------------------------------- patches */
  P.PATCHES = [
    {
      id: 'init', name: 'Init', group: 'Basic',
      patch: {
        note: { midi: 60 },
        sample: { duration: 1 },
        harmonics: { count: 8, rules: [rule('n === 1 ? 1 : 0')] },
        envelopes: {
          amp: { enabled: true, points: pts([[0, 0, 0.5], [0.02, 1, 0.4], [0.7, 1, 0], [1, 0, -0.5]]) },
          pitch: { enabled: false, depth: 12, points: pts([[0, 0], [1, 0]]) },
          filter: { enabled: false, depth: 4, points: pts([[0, 0], [1, 0]]) }
        }
      }
    },
    {
      id: 'pluck', name: 'Analog saw pluck', group: 'Basic',
      patch: {
        note: { midi: 57 },
        sample: { duration: 1.4 },
        harmonics: { count: 32, rules: [rule('1/n')] },
        filter: { enabled: true, type: 'lowpass', cutoff: 5200, q: 1.6 },
        envelopes: {
          amp: { enabled: true, points: pts([[0, 0, 0.7], [0.006, 1, 0.5], [0.3, 0.22, -0.6], [1, 0, -0.7]]) },
          filter: { enabled: true, depth: 3.4, points: pts([[0, 0.85, 0.4], [0.4, -0.2, -0.5], [1, -0.5, -0.4]]) }
        }
      }
    },
    {
      id: 'pad', name: 'Warm square pad', group: 'Basic',
      patch: {
        note: { midi: 60 },
        sample: { duration: 3.2 },
        voice: { unison: 3, spread: 14, stereo: true },
        harmonics: {
          count: 24,
          rules: [rule('odd(n) ? 1/n : 0'), rule('slope(n, 0.35)', { mode: 'mul', amount: 1 })]
        },
        filter: { enabled: true, type: 'lowpass', cutoff: 2600, q: 0.9 },
        envelopes: {
          amp: { enabled: true, points: pts([[0, 0, -0.6], [0.28, 1, -0.4], [0.72, 0.86, 0.2], [1, 0, -0.4]]) },
          filter: { enabled: true, depth: 2.2, points: pts([[0, -0.3, -0.5], [0.45, 0.7, -0.3], [1, -0.1, 0.4]]) }
        }
      }
    },
    {
      id: 'bass', name: 'Odd-harmonic bass drop', group: 'Bass',
      patch: {
        note: { midi: 36 },
        sample: { duration: 1.1 },
        harmonics: { count: 20, rules: [rule('odd(n) ? 1/n : 0'), rule('n === 1 ? 1.6 : 1', { mode: 'mul' })] },
        filter: { enabled: true, type: 'lowpass', cutoff: 1400, q: 3.2 },
        envelopes: {
          amp: { enabled: true, points: pts([[0, 0, 0.8], [0.004, 1, 0.5], [0.55, 0.75, -0.3], [1, 0, -0.6]]) },
          pitch: { enabled: true, depth: 14, points: pts([[0, 1, 0.6], [0.09, 0.85, 0.5], [0.6, -0.1, -0.4], [1, -0.25, -0.3]]) },
          filter: { enabled: true, depth: 3, points: pts([[0, 0.9, 0.3], [0.35, -0.3, -0.5], [1, -0.6, -0.4]]) }
        }
      }
    },
    {
      id: 'thirds', name: 'Every third harmonic', group: 'Experiments',
      patch: {
        note: { midi: 48 },
        sample: { duration: 2 },
        harmonics: { count: 36, rules: [rule('mod(n, 3, 0) ? 1 : 0.05')] },
        envelopes: {
          amp: { enabled: true, points: pts([[0, 0, 0.6], [0.02, 1, 0.3], [0.5, 0.8, 0.2], [1, 0, -0.6]]) }
        }
      }
    },
    {
      id: 'primes', name: 'Prime harmonics swell', group: 'Experiments',
      patch: {
        note: { midi: 45 },
        sample: { duration: 4 },
        voice: { unison: 2, spread: 9, stereo: true },
        harmonics: { count: 48, phaseBase: 'golden', rules: [rule('prime(n) ? 1/sqrt(n) : 0.03')] },
        filter: { enabled: true, type: 'lowpass', cutoff: 6000, q: 1.2 },
        envelopes: {
          amp: { enabled: true, points: pts([[0, 0, -0.7], [0.4, 1, -0.3], [0.75, 0.9, 0.2], [1, 0, -0.5]]) }
        }
      }
    },
    {
      id: 'fibbell', name: 'Fibonacci bell', group: 'Experiments',
      patch: {
        note: { midi: 69 },
        sample: { duration: 3.5 },
        harmonics: { count: 34, phaseBase: 'golden', rules: [rule('isFib(n) ? exp(-n/14) : 0.02 * exp(-n/20)')] },
        envelopes: {
          amp: { enabled: true, points: pts([[0, 0, 0.9], [0.003, 1, 0.4], [0.25, 0.35, -0.6], [1, 0, -0.7]]) }
        }
      }
    },
    {
      id: 'ring', name: 'Comb / ring flavour', group: 'Experiments',
      patch: {
        note: { midi: 52 },
        sample: { duration: 1.8 },
        harmonics: { count: 44, rules: [rule('comb(n, 7, 1.25)')] },
        envelopes: {
          amp: { enabled: true, points: pts([[0, 0, 0.8], [0.005, 1, 0.3], [0.4, 0.3, -0.5], [1, 0, -0.6]]) },
          pitch: { enabled: true, depth: 5, points: pts([[0, 0.4], [1, -0.4, -0.4]]) }
        }
      }
    },
    {
      id: 'vowel', name: 'Vowel A formants', group: 'Experiments',
      patch: {
        note: { midi: 45 },
        sample: { duration: 2.6 },
        harmonics: { count: 32, rules: [rule('gauss(f,730,90) + 0.55*gauss(f,1090,110) + 0.25*gauss(f,2440,170)')] },
        envelopes: {
          amp: { enabled: true, points: pts([[0, 0, -0.5], [0.18, 1, -0.3], [0.7, 0.95, 0.1], [1, 0, -0.5]]) },
          filter: { enabled: false, depth: 2, points: pts([[0, 0], [1, 0]]) }
        }
      }
    },
    {
      id: 'noiseburst', name: 'Noise burst', group: 'Percussion',
      patch: {
        note: { midi: 60 },
        sample: { duration: 0.5 },
        harmonics: { count: 48, phaseBase: 'rand', seed: 20250101, rules: [rule('rand(n)', { phase: 'rand(n + 977)' })] },
        filter: { enabled: true, type: 'bandpass', cutoff: 3200, q: 1.1 },
        envelopes: {
          amp: { enabled: true, points: pts([[0, 0, 0.9], [0.002, 1, 0.6], [0.25, 0.1, -0.8], [1, 0, -0.7]]) },
          filter: { enabled: true, depth: 3, points: pts([[0, 0.8], [1, -0.8, -0.5]]) }
        }
      }
    },
    {
      id: 'acid', name: 'Acid pluck', group: 'Percussion',
      patch: {
        note: { midi: 45 },
        sample: { duration: 0.7 },
        harmonics: { count: 24, rules: [rule('odd(n) ? 1/n : 0'), rule('slope(n, -0.25)', { mode: 'mul' })] },
        filter: { enabled: true, type: 'lowpass', cutoff: 900, q: 9 },
        envelopes: {
          amp: { enabled: true, points: pts([[0, 0, 0.9], [0.003, 1, 0.4], [0.4, 0.25, -0.7], [1, 0, -0.6]]) },
          filter: { enabled: true, depth: 5, points: pts([[0, 1, 0.5], [0.3, -0.4, -0.6], [1, -0.8, -0.4]]) }
        }
      }
    },
    {
      id: 'tom', name: 'Pitched tom', group: 'Percussion',
      patch: {
        note: { midi: 48 },
        sample: { duration: 0.9 },
        harmonics: { count: 14, rules: [rule('n < 4 ? 1/n : 0.06 * rand(n)')] },
        envelopes: {
          amp: { enabled: true, points: pts([[0, 0, 0.9], [0.002, 1, 0.5], [0.35, 0.15, -0.7], [1, 0, -0.6]]) },
          pitch: { enabled: true, depth: 9, points: pts([[0, 1, 0.7], [0.3, 0, -0.6], [1, -0.15, -0.3]]) }
        }
      }
    },
    {
      id: 'reese', name: 'Detuned reese', group: 'Bass',
      patch: {
        note: { midi: 33 },
        sample: { duration: 3 },
        voice: { unison: 5, spread: 26, stereo: true },
        harmonics: { count: 40, rules: [rule('1/n'), rule('gauss(n, 3, 2.2)', { mode: 'add', amount: 0.5 })] },
        filter: { enabled: true, type: 'lowpass', cutoff: 780, q: 2.4 },
        envelopes: {
          amp: { enabled: true, points: pts([[0, 0, -0.7], [0.22, 1, -0.4], [0.8, 0.9, 0.2], [1, 0, -0.5]]) },
          filter: { enabled: true, depth: 2.6, points: pts([[0, -0.4, -0.5], [0.5, 0.6, -0.3], [1, -0.2, 0.4]]) }
        }
      }
    },
    {
      id: 'glass', name: 'Glass shard', group: 'Textures',
      patch: {
        note: { midi: 81 },
        sample: { duration: 2.4 },
        voice: { unison: 2, spread: 7, stereo: true },
        harmonics: { count: 56, phaseBase: 'golden', normalize: 'rms', rules: [rule('abs(sinc((n-11)/2.4)) * exp(-n/40) + 0.02')] },
        envelopes: {
          amp: { enabled: true, points: pts([[0, 0, 0.9], [0.004, 1, 0.4], [0.35, 0.25, -0.6], [1, 0, -0.8]]) }
        }
      }
    },
    {
      id: 'sweep', name: 'Pink sweep', group: 'Textures',
      patch: {
        note: { midi: 57 },
        sample: { duration: 3 },
        harmonics: { count: 48, phaseBase: 'rand', rules: [rule('pink(n)', { phase: 'rand(n + 31)' })] },
        filter: { enabled: true, type: 'lowpass', cutoff: 1200, q: 4 },
        envelopes: {
          amp: { enabled: true, points: pts([[0, 0, -0.6], [0.35, 1, -0.4], [0.8, 0.8, 0.2], [1, 0, -0.5]]) },
          filter: { enabled: true, depth: 4.5, points: pts([[0, -0.9, -0.6], [0.55, 0.9, -0.4], [1, -0.4, 0.5]]) }
        }
      }
    },
    {
      id: 'tremstrings', name: 'Tremolo strings', group: 'Textures',
      patch: {
        note: { midi: 64 },
        sample: { duration: 3 },
        voice: { unison: 3, spread: 11, stereo: true },
        harmonics: { count: 28, rules: [rule('slope(n, 1.4)'), rule('mod(n,4,0) ? 0.4 : 1', { mode: 'mul' })] },
        filter: { enabled: true, type: 'lowpass', cutoff: 4200, q: 0.8 },
        envelopes: {
          amp: {
            enabled: true,
            points: pts([[0, 0, -0.6], [0.12, 0.85, -0.4], [0.25, 1, 0.5], [0.38, 0.7, 0.5], [0.5, 1, 0.5],
              [0.62, 0.72, 0.5], [0.75, 1, 0.5], [0.88, 0.75, 0.5], [1, 0, -0.5]])
          }
        }
      }
    },
    {
      id: 'staircase', name: 'Staircase sequencer', group: 'Textures',
      patch: {
        note: { midi: 55 },
        sample: { duration: 2 },
        harmonics: { count: 18, rules: [rule('odd(n) ? 1/n : 0')] },
        filter: { enabled: true, type: 'lowpass', cutoff: 3000, q: 2 },
        envelopes: {
          amp: { enabled: true, points: pts([[0, 1, 0, true], [0.25, 0.6, 0, true], [0.5, 0.85, 0, true], [0.75, 0.35, 0, true], [1, 0]]) },
          pitch: { enabled: true, depth: 12, points: pts([[0, 0, 0, true], [0.25, 0.585, 0, true], [0.5, -0.415, 0, true], [0.75, 0.25, 0, true], [1, 0]]) }
        }
      }
    }
  ];

  /* Quick lookup used by the UI select. */
  P.byId = function (id) {
    for (var i = 0; i < P.PATCHES.length; i++) if (P.PATCHES[i].id === id) return P.PATCHES[i];
    return null;
  };

})(typeof window !== 'undefined' ? window : globalThis);
