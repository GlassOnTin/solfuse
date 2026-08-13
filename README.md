# SolFuse — stack solar video in your browser

Drop in a clip of the sun through a filter. Get back one stacked image with the
sensor noise averaged away and atmospheric distortion partly corrected. Runs
entirely on your device — no upload, no backend.

See [VISION.md](VISION.md) for the design and what the measurements changed.
This file is the record of what has been measured.

---

## Pipeline

```
video -> requestVideoFrameCallback -> green plane
  pass 1:  disc centroid -> ECC refine (quarter scale) -> warp -> accumulate
  pass 2:  warp with cached transform -> ~180 alignment points
           -> matchTemplate + parabolic sub-pixel -> displacement field
           -> remap -> accumulate
  render:  percentile stretch, optional unsharp mask
```

---

## Seeing what it is doing

The process is more interesting than the result, so the app shows it rather than
hiding it behind a progress bar.

- **The stack builds in front of you.** A preview updates at frames 1, 2, 4, 8,
  16 and then every 20 — powers of two first because that is where the visible
  change is fastest.
- **The distortion field is drawn over it.** Each alignment point shows the
  displacement it measured, exaggerated 10–60×. The vectors do not all point the
  same way, which is the entire argument for multi-point alignment in one
  picture. Only cells carrying a real measurement are drawn; the interpolated
  remainder is not, because confident arrows over empty sky would be a lie.
- **A timeline** of per-frame distortion magnitude. Seeing wanders over about a
  second, so a smooth meander is the expected shape and spikes usually mean a
  frame failed to match.
- **A before/after wipe** between one frame and the stack, both rendered through
  the *same* tone curve — otherwise the panel would be comparing two stretches.
- **A stats panel** reporting what this run achieved on your frames, not what
  the README claims. Every figure is derived from your own data, and where one
  cannot be computed it is omitted rather than guessed.

The two headline stats are worth explaining because they are honest in a way
single-stack measures are not:

**Noise reduction** compares one frame against the finished stack. The two
half-stacks differ only by noise, so if each carries σ then sd(odd − even) =
σ√2 and the full stack carries sd(odd − even)/2. Verified against synthetic data
with known noise: 8.00 DN injected, 8.126 measured; stack noise 1.271 against a
theoretical 1.265; reduction ×6.39 against a theoretical ×6.32.

**Split-half SNR** correlates the odd- and even-frame stacks in a band. Real
structure appears in both, noise does not, so r/(1−r) is a signal-to-noise
ratio, and the ratio between the global and multi-point stacks is what the
second pass actually bought.

## Measured behaviour

All figures come from **C0013.MP4**: 1140 frames of real 4K solar video, 25 fps,
52 Mbps H.264, disc ~1870 px across, shot through a dense solar ND filter.

### Multi-point alignment is the win

Split-half reliability — odd frames stacked separately from even frames, so
reproducible structure appears in both halves and noise does not:

| band | global align | multi-point | SNR gain |
|---|---|---|---|
| fine (1.4–3.2 px) | r = 0.9855 | r = 0.9891 | **1.34×** |
| mid (3–7 px) | r = 0.9967 | r = 0.9976 | **1.34×** |
| coarse (7–15 px) | r = 0.9985 | r = 0.9990 | **1.49×** |

Reproducible fine-detail amplitude rises **9.8%**. The distortion being
corrected measures **1.33 px mean, 2.03 px at p95** — small, but comparable to
the scale of the detail itself, which is why removing it matters.

Against a single frame, stacking cuts high-frequency noise to **0.106×** (a 9.4×
reduction).

### Frame selection is not worth shipping

The lucky-imaging premise, tested against a seeded random control of identical
size:

| stack | noise | mid-detail | detail/noise |
|---|---|---|---|
| best 25%, raw band energy | 0.104 | 0.286 | 2.75 |
| best 25%, noise-normalised | 0.089 | 0.250 | 2.80 |
| random 25% (control) | 0.083 | 0.230 | 2.77 |
| all 1140 frames | 0.076 | 0.229 | **3.01** |

Selection buys **1.0%** over its own control at best, and stacking everything
beats every subset. The first metric was worse than useless: it selected frames
with 24% more "detail" *and* 25% more noise, i.e. it ranked by total
high-frequency energy and picked the grainiest frames.

### The naive sharpness metric grades the codec

Laplacian energy inside the disc across 3720 frames of C0014, split by H.264
picture type:

| metric | I | P | B | composition of the best 10% |
|---|---|---|---|---|
| raw Laplacian | 31.1 | 32.8 | 38.9 | **B 99%**, I 0%, P 0% |
| difference-of-Gaussians | 0.7 | 0.7 | 0.7 | I 22%, P 43%, B 34% |
| blurred gradient | 42.3 | 41.8 | 40.7 | I 24%, P 45%, B 29% |

B-frames are 66% of the population, so the raw metric is essentially selecting
*"the B-frames"*. Its autocorrelation shows the 12-frame GOP period beating
through — dips at lag 5, rising again at lags 10 and 25. Band-limiting removes
the dependence entirely.

### Why selection fails here, physically

A dense solar ND filter forces a long exposure, a high gain, or both. The high
gain produced the large single-frame noise, which is why stacking wins so
clearly. The long exposure **time-averaged the seeing inside each frame**, which
is why there was almost no frame-to-frame sharpness variation left to select on.
Both observations are the same fact.

For a capture where lucky imaging would pay, use manual exposure with the
fastest shutter the filter allows and accept the ISO: stacking removes sensor
noise, but nothing removes seeing blur baked into an exposure.

### Browser against headless

The browser and the node harness run the same `pipeline.js`. On the same 40 real
4K frames:

| | node | browser |
|---|---|---|
| alignment points | 182 | 182 |
| points used per frame | 168 | 170.7 |
| ECC refinement, median | 1.87 px | 1.90 px |
| displacement field, median | 1.96 px | 2.04 px |
| ECC failures | 0 | 0 |

Small differences are expected: the browser test was fed JPEG-re-encoded frames
because this environment could not hand it the video directly. On the full 1140
frames the node port finds **183 alignment points**, matching the Python
prototype exactly.

Browser timings, 40 frames of 4K into a 2100 px canvas, desktop Chrome 142:
pass 1 **15.3 s**, pass 2 **25.9 s**, accumulators **235 MB**. Extrapolated, a
full 45-second clip is roughly 20 minutes. The alignment work dominates; video
decode at playback speed contributes about 90 seconds of that.

---

## Not tested

- **The video path itself has not been verified in a browser.** The automation
  Chrome available here cannot decode video at all — not a 12 KB H.264 clip, not
  a VP9 WebM, no error, no events. Everything downstream of frame extraction was
  verified by feeding real frames as images instead, so `extractFrames` and its
  dropped-frame detection remain unexercised.
- No phone, no Firefox, no Safari.
- One video, one camera, one filter, one day's seeing.
- Planetary targets untested; the coarse stage assumes a full disc with a limb.
- The 2800 px output option is untested; 2100 px is what all figures above use.

---

## Running it

```sh
python3 -m http.server 8413        # then open http://localhost:8413/
```

Headless, against any video ffmpeg can read:

```sh
node tools/bench-solar.js /path/to/clip.MP4 --frames 200 --write testdata/out
```

It reports split-half reliability for global against multi-point alignment, which
is the measurement that decides whether the extra pass earned its keep.

Before deploying, run `tools/bump-cache.sh` — Pages serves `max-age=600`.

## Repository layout

| | |
|---|---|
| `index.html` | markup, CSS, inline pre-module error trap |
| `app.js` | video frame extraction, drives the two passes, export |
| `worker.js` | OpenCV, accumulators, message protocol |
| `pipeline.js` | the algorithm — loaded by both the worker and node |
| `tools/bench-solar.js` | headless harness, split-half reliability |
| `tools/png.js` | minimal PNG writer for the harness (not shipped) |
| `vendor/` | OpenCV.js, pinned by hash |

## On the OpenCV build

`@techstark/opencv-js` 5.0.0-release.1. The module export is a *thenable*, not
an object with `onRuntimeInitialized`. Registration uses only calls verified
present: `warpAffine`, `findTransformECC`, `matchTemplate`, `minMaxLoc`,
`remap`, `resize`, `GaussianBlur`, `erode`, `threshold`, `meanStdDev`.

## Licence

AGPL-3.0.
