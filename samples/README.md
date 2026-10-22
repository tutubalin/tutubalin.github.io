# SampleForge — audio sample generator

A single-page **audio sample generator** in pure HTML/CSS/JavaScript. No frameworks, no build
step, no dependencies: open `index.html` and it runs.

You design a one-shot sample from three independent, fully interactive layers:

| Layer | What you do with it |
| --- | --- |
| **Envelope** | Breakpoint curve editor — drag points, click to add, double-click/right-click to remove, bend each segment, mark segments as holds. Three destinations: amplitude, pitch and filter. |
| **Waveform** | Pick a classic wave (sine, triangle, square, saw, pulse, organ drawbars, noise, bell, vowel formants…) **or draw your own cycle freehand** with the mouse. The drawing is analysed and becomes the spectrum. |
| **Harmonics** | A **rule stack** of expressions over the harmonic index `n`. Not a list of presets — anything you can write down: all, even only, odd only, every third, primes, Fibonacci, formant stacks, seeded noise, combs, arbitrary maths. Plus per-harmonic manual amplitude **and phase** editing. |

Then play it (on-screen piano or your computer keyboard), watch the offline render, and export a
WAV.

---

## Running it

```bash
# option A — just open the file
open index.html            # macOS
xdg-open index.html        # Linux

# option B — serve it (needed if you want the share-link/clipboard features to behave)
python3 -m http.server 8000
# → http://localhost:8000
```

Web Audio starts on your first click or key press (browser autoplay policy), so the status bar
reads `audio: idle` until you interact.

### Dev smoke test (optional)

`tools/smoke.mjs` boots the real app under Node against a small DOM + Web Audio shim and runs
66 checks over the DSP maths, the editors (synthetic pointer events), the presets, the WAV writer
and the export path. The Web Audio shim reports anything a browser would reject — overlapping
automation events, non-finite param values, malformed `PeriodicWave`s.

```bash
node tools/smoke.mjs
```

---

## How the three editors fit together

```
 harmonic rules ──► normalise ──► manual overrides ──► spectrum (amp + phase per harmonic)
        ▲                                ▲                            │
        │                                │                            ▼
   rule stack UI          drag bars / phase lane          PeriodicWave ──► oscillator(s)
                                 ▲                                                    │
                                 │                                                    ▼
                     DFT of your drawing ◄── waveform editor            filter ──► amp envelope ──► out
                                                                                          ▲
                                                                       envelope editor ───┘
```

The waveform editor and the harmonic editor are **two views of the same data**. Drawing runs a
DFT over your stroke and writes the result into the spectrum; editing bars rebuilds the cycle you
see in the waveform view. Manual edits are stored as *overrides* that sit on top of the rule
stack, so the rules stay live and editable — `Clear manual edits` hands everything back to them.

Live playback and the WAV export use **the same graph builder**: an `AudioContext` for auditioning
and an `OfflineAudioContext` for rendering. Envelopes are sampled from the breakpoint model and
handed to `AudioParam.setValueCurveAtTime()`, so curves are reproduced exactly (no ramp
approximation) and what you hear is what you export.

---

## Harmonic rule language

Each rule is `amplitude = combine(amplitude, amount × expression(n))`, evaluated for every
harmonic `n = 1 … N`, top to bottom. Combine modes: `set`, `mul`, `add`, `max`, `min`.
A rule can also carry a **phase** expression, in turns (`1 = 360°`), added to or replacing the
base phase.

**Variables** — `n` (index), `i` (`n-1`), `f` (Hz of this harmonic), `h` (`n/N`), `N` (count),
`fund` (fundamental Hz), `nyq`, `sr`, `seed`.

**Selection** — `even(n)` `odd(n)` `mod(n,k,r)` `every(n,k,r)` `prime(n)` `isFib(n)`
`coprime(n,k)` `gcd(a,b)` `band(n,lo,hi)` `step(n,k)`

**Classic spectra** — `saw(n)` `sqr(n)` `tri(n)` `pulse(n,duty)` `slope(n,s)` (= `n^-s`)

**Shapes & noise** — `gauss(x,center,width)` `comb(x,spacing,width)` `formant(hz,bw)` `sinc(x)`
`smoothstep(a,b,x)` `rand(n[,seed])` `noise(n)` `pink(n)` `brown(n)` `randSigned(n)`

**Math** — `sin cos tan asin acos atan atan2 abs sign sqrt cbrt exp log log2 log10 pow min max
hypot floor ceil round trunc fract clamp mix db` and the constants `pi tau e phi`.

Anything else in JavaScript works too — ternaries, array literals, comparisons:

```js
odd(n) ? 1/n : 0                                  // square
mod(n, 3, 0) ? 1 : 0.04                           // every third harmonic
prime(n) ? 1/sqrt(n) : 0.02                       // primes only
n < 9 ? [1, 0, .5, 1, 0, .35, 0, .22][n-1] : 0    // organ drawbars
gauss(f,730,90) + .55*gauss(f,1090,110)           // vowel formants in Hz
comb(n, 7, 1.2)                                   // metallic comb
exp(-n/5) * (.45 + .55*sin(n*1.9))                // bell-ish partials
rand(n)                                           // seeded white noise
```

Broken expressions never break the app: the rule row turns red and shows the message, and the
affected harmonics fall back to 0. `Expression reference & recipes` inside the harmonics panel has
24 one-click recipes.

### Phase

`Base phase` sets the whole spectrum (`all sine`, `all cosine`, `alternate 0°/180°`, `random`,
`golden spiral`), a rule can add or replace phase per harmonic, and the phase lane under the bars
lets you rotate individual harmonics by hand. Phase is what turns an amplitude spectrum into
something with a shape — triangle vs. square, a pulse vs. a smear.

### Anti-aliasing

With **Anti-alias** on, harmonics above Nyquist for the *currently played note* are dropped before
they reach the oscillator (they would fold back as aliasing). The harmonics panel draws a red
Nyquist line and dims the dropped bars, so the same patch legitimately looks different at C2 and
C7.

---

## Envelopes

- **Amplitude** — always on, spans the whole sample (`Length`, 0.01–30 s).
- **Pitch** — bipolar, in semitones (`Range` up to ±48 st), applied to the oscillator frequency.
- **Filter** — bipolar, in octaves around the filter cutoff.

Every breakpoint has a time, a value, a **curvature** (drag the small square on the segment — it
solves the exponential ramp so the curve passes exactly under your cursor) and an optional
**hold** (double-click the handle, or press `h` with a point selected). Shapes: flat, gate, pluck,
perc, ADSR, pad, swell, tremolo, stairs, dip (plus rise/fall/scoop/drop/bump/wobble/steps for the
modulation envelopes).

Snapping is on by default (`Snap` button); hold **Shift** while dragging to bypass it. Select a
point and use the arrow keys to nudge, `Delete` to remove, `Tab` to cycle through points. The
inspector row shows exact time in ms, value and curvature.

---

## Keyboard & transport

| Key | Action |
| --- | --- |
| `A W S E D F T G Y H U J K L` | play notes (the letters are printed on the on-screen keys) |
| `Z` / `X` | move the on-screen keyboard down / up an octave |
| `Space` | play / stop |
| `Esc` | stop |
| `L` | toggle loop |
| `Ctrl/⌘ + Z` · `Ctrl/⌘ + Shift + Z` | undo · redo |
| `Ctrl/⌘ + S` · `Ctrl/⌘ + E` | save patch JSON · export WAV |

Looping uses a look-ahead scheduler and re-reads the patch for every pass, so you can keep dragging
harmonics or envelope points **while it loops** and hear the change on the next pass.

---

## Voice, render, export

- **Unison** 1–5 voices with a detune **spread** in cents, panned across the stereo field.
- **Filter** — any biquad type, cutoff (log scale 20 Hz–20 kHz), Q, modulated by the filter envelope.
- **Auto-trim** keeps the waveform peak at unity regardless of how many harmonics you stack.
- **Render** — 22.05/44.1/48/88.2/96 kHz, 16-bit PCM, 24-bit PCM or 32-bit float, mono or stereo,
  with normalise-to-peak and fade in/out. The `Rendered sample` panel is the actual offline render
  (peaks, RMS, DC, clip count, render time), not a drawing of the math.
- **Export WAV** writes `note-name-filename-rate-depth.wav`.

## Patches

- **Presets…** in the top bar: 17 factory patches (bass, pluck, pad, acid, reese, bells, noise
  burst, formant vowel, prime/Fibonacci/comb experiments, tremolo strings, staircase sequencer…).
- **Save / Load**: patch JSON.
- **Link**: the whole patch (rules, overrides, envelopes, voice) base64-encoded into the URL hash —
  it is also written to the address bar as you work, so a refresh never loses your sound.
- **Undo/redo** covers everything, and one drag = one undo step.

A console API is exposed for tinkering:

```js
SampleForge.state()        // current patch
SampleForge.spectrum()     // computed amps/phases/errors
SampleForge.json()         // pretty patch JSON
SampleForge.render()       // Promise<AudioBuffer> of the offline render
SampleForge.patch({ ... }) // load a patch
```

---

## Layout

```
index.html            markup for every panel
styles.css            dark UI, responsive grid, no framework
js/utils.js           math, formatting, canvas/pointer helpers
js/envelope.js        breakpoint envelope model (pure math)
js/harmonics.js       rule engine, spectrum pipeline, DFT ⇄ waveform, wave tools
js/presets.js         waveform presets + factory patches
js/store.js           state, sanitising, undo/redo, JSON + URL hash
js/wav.js             RIFF/WAVE writer (16/24/32-bit) + buffer stats
js/audio.js           voice graph, transport, look-ahead loop, offline render
js/editors/base.js    shared canvas editor base (DPR, resize, plot maths, theme)
js/editors/waveform.js    draw/line/erase tools, DFT binding, wave ops
js/editors/harmonic.js    amplitude bars + phase lane
js/editors/envelope.js    breakpoint editor with curvature and holds
js/keyboard.js        on-screen piano + computer-key mapping
js/ui.js              all DOM wiring, rule stack UI, preview render, export
js/main.js            bootstrap
tools/                Node smoke test + DOM/Web Audio shims (dev only)
```

Everything is ES5-style classic scripts on a single `SG` namespace, which is why the page also
works straight off the filesystem (`file://`) without a server or CORS surprises.
