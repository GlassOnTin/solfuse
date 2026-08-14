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

### The selection trade-off

Lucky imaging says keep the sharpest few percent; averaging says keep
everything. Which is right depends on the footage, so SolFuse measures the whole
curve instead of assuming, and reports where the balance actually falls.

Frames are ranked in pass 1 by a noise-normalised band-limited metric. In pass 2
a full-resolution region of interest — centred on the highest-contrast alignment
point, because measuring detail over blank photosphere measures nothing — is
accumulated into nested keep-fraction stacks, each with its own odd/even halves.
The statistic reported at each fraction is

```
A(f) = √r_f × rms_fine(stack of the best f)
```

**Split-half SNR on its own cannot answer this question.** Blur is reproducible:
as blurrier frames are added, noise falls and `r` keeps climbing, so an SNR curve
would conclude "use everything" no matter how much the seeing varied. The `√r`
factor discounts noise while `rms_fine` falls when blurred frames dilute the
detail, so the product peaks at the genuine balance point.

Measured on 60 frames of C0013:

| keep | frames | r | rms | A |
|---|---|---|---|---|
| 10% | 6 | 0.9978 | 6.719 | 6.712 |
| 25% | 15 | 0.9991 | 6.773 | 6.770 |
| 50% | 30 | 0.9997 | 6.792 | 6.791 |
| all | 60 | 0.9999 | 6.845 | **6.845** |

Monotonic to 100%: averaging wins outright, and the gain from selecting is
×1.000. That agrees with the earlier finding that selection buys about 1%,
reached by an entirely different measure — two independent methods giving the
same answer.

One caveat on reading the curve: on a high-contrast target `r` saturates near 1,
as it does above, so the comparison is carried almost entirely by `rms` and the
`√r` term does little work. On noisier footage, or a fainter target, it matters
much more. The curve costs about 13% on pass 1 and can be turned off.

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

### Two things this measurement got wrong

Recorded because both were caught by checking rather than by reasoning, and both
would otherwise have shipped as facts.

**The displacement field was inflated by cells that measured nothing.** Only
about 40% of grid cells carry a locatable alignment point — 182 of 441 on a 4K
disc. The rest were filled by propagating the nearest measurement outward with
no decay, which invents motion over empty sky beyond the limb. Measured cells
carried a median 0.32 px displacement; the filled ones carried 0.74 px, more
than double. The field is now tapered to zero within 2.5 grid steps of the last
real measurement, which halves the reported magnitude (2.24 → 1.12 px median on
300 frames) and makes the number mean what it says.

**The coarse-band SNR ratio was never evidence.** A full 1140-frame run showed
multi-point alignment scoring 0.938× against global alignment in the 7–15 px
band — apparently worse. The taper above was the obvious suspect, so it was
A/B tested at 300 frames: with and without, the coarse gain came out 1.193×
against 1.194×. The taper was not the cause.

The real cause is the metric. `SNR = r/(1−r)` diverges as r approaches 1, and
the coarse band sat at r = 0.9984 against 0.9983 — a difference of 1×10⁻⁴,
amplified into a 6% swing. Correlations above about 0.995 carry no usable
information in this form, in either direction, and are now flagged as such
wherever they are reported. The fine band, where r runs 0.96–0.99, is the one to
read: it gives 1.24× at 300 frames and 1.31× at 1140, against the Python
prototype's 1.34×.

### Why registration is a centroid and not a correlation

The obvious objection to locating the disc by its centre of mass is that it
breaks when the lit region is clipped by the frame edge, or when the Moon eats
half the disc. Cross-correlation looks like the more robust answer. Measured on
684 frames of a partial eclipse — a deep crescent, clipped at the bottom of the
sensor, drifting 580 px in 27 seconds — it is not.

Judged by how much ECC has to correct afterwards, and the correlation ECC
reaches:

| coarse method | ECC left to fix | p90 | ECC correlation | failures |
|---|---|---|---|---|
| centroid | **2.23 px** | 4.85 | 0.99938 | 0 |
| cross-correlation @ 1/8 | 3.26 px | 8.10 | 0.99937 | 0 |
| cross-correlation @ 1/4 | 3.30 px | 8.28 | 0.99939 | 0 |
| cross-correlation @ 1/2 | 3.24 px | 8.29 | 0.99938 | 0 |

Flat across scales, so this is not sub-pixel quantisation: the correlation peak
is intrinsically broad. A crescent is a large, smooth, low-texture blob, and
correlating it against itself gives a wide plateau with nothing for a sub-pixel
fit to grip. The centroid wins because it is an *integral* estimator, averaging
over ~850,000 lit pixels of a high-contrast object on a black background.

**Phase correlation is worse still, and instructively so.** It was hand-rolled
from `dft` — the build has no `phaseCorrelate`, no `mulSpectrums` and no
`idft` — and validated on deltas, where it is exact: an 8x8 image shifted by
(+3, +2) puts the peak at (5, 6), the correct wrapped position. On the crescent
it returns zero shift every time. Sweeping the whitening from full to none:

| whitening | worst error |
|---|---|
| full (pure phase correlation) | 14.2 px |
| 0.1 | 5.8 px |
| 1 | 3.6 px |
| 10 (approaching plain cross-correlation) | 2.0 px |

Accuracy improves monotonically as whitening is *reduced*. Phase correlation
assumes a broadband spectrum: a delta has one, so every bin carries signal, but
a smooth crescent's spectrum decays fast and most high-frequency bins hold only
numerical noise. Whitening rescales that noise to unit magnitude alongside the
real content, and it swamps the phase ramp.

The corollary is that phase correlation would be an excellent choice for a star
field, where the image really is a sum of deltas — but that is AstroFuse's
problem, and it needs rotation, which plain phase correlation does not give.

On this footage the choice barely matters anyway: every method reached ECC
correlation 0.99938 with zero failures. The coarse stage is not the bottleneck.
The framing is.

### Deconvolution, with the PSF measured rather than assumed

A limb is a step edge of known geometry, so its edge-spread function gives the
point spread function directly. No parametric family is assumed and no PSF is
optimised against a sharpness score — a score that would happily converge on
amplified noise.

Two details decide whether the answer is usable, and both were found by checking
rather than reasoning:

**Normalise each profile before averaging.** Limb darkening means the
photosphere behind one part of the arc is not as bright as behind another.
Binning by radius alone mixes those plateaux and smears the edge: it measured
the blur 37% too wide, and the recovered PSF failed to re-project onto its own
data. Rescaling each profile to its own dark and bright levels first took the
re-projection error from **18.4% to 4.0%** and the FWHM from 14.28 to 10.45 px.

**Prefer the lunar limb.** The Moon has no atmosphere and no limb darkening, so
during an eclipse it is very nearly an ideal knife edge laid across the brightest
object in the sky. Measured on the same stack, the solar limb reads **1.44x
wider** — that excess is limb darkening, not blur.

Recovery is by MTF rather than by fitting: for a radially symmetric system the
MTF is the magnitude of the Fourier transform of the line-spread function, so
rotating it into a 2D transfer function and inverting gives the PSF whatever its
shape. A disc-convolved-gaussian fit was tried first and left a 17% residual;
the transform route is assumption-free and validated by re-projection.

Measured on the eclipse stack: **FWHM 9.81 px, sigma 4.17 px, kurtosis 4.28**
from 1502 averaged edge profiles, in 408 ms. Kurtosis is the useful diagnostic:
3.0 is gaussian, ~2.0–2.3 is the flat-topped disc of pure defocus, and above 3.6
is the heavy-tailed profile of seeing. This clip is seeing-limited, not
focus-limited.

**Richardson–Lucy rings at hard edges, and it is not subtle.** At 20 iterations
on the eclipse crescent the lunar limb grows a bright overshoot line and the dark
lunar disc mottles visibly. Most of a 36 DN mean change was that artefact rather
than recovered detail. Deconvolution is off by default, capped in the UI, and
carries the warning; a full disc, whose only hard edge is the sun's own limb,
tolerates far more than an occulted one does. 20 iterations at 2100 px with a
41x41 kernel takes about 3.5 s.

### Deconvolution stability, and what the anti-ringing measures were worth

**The deconvolution first released was diverging, not ringing.** Richardson–Lucy
divides by the blurred estimate; in a dark sky that tends to zero, and with a
1e-6 epsilon the ratio explodes. The result reached 900 DN of "overshoot" on an
8-bit image. What looked like catastrophic ringing was a numerical blow-up.

Three guards fix it: an epsilon scaled to the data rather than fixed, a cap on
the per-iteration ratio, and a physical ceiling on the estimate. The last one
matters most — capping the ratio at 4 still permits 4^20 over a 20-iteration run.
With all three, output stays bounded: mean 44.2 to 40.1 DN over 20 iterations
with 5% of pixels reaching the ceiling.

Ringing is then measured rather than eyeballed, by sampling the radial profile
across the fitted limb and taking the overshoot above the local plateau:

| variant | overshoot | in sigma |
|---|---|---|
| stacked, no deconvolution | 1.01 DN | 1.2 |
| plain RL, 20 iterations | 33.35 | 2.2 |
| + saturation masking | 34.58 | 2.5 |
| + support constraint | 35.53 | 2.5 |
| + TV, lambda 0.002 | 33.06 | 3.4 |
| + TV, lambda 0.01 | 32.50 | 4.2 |

**Honest result: none of them helps much here.** Overshoot moves from 33.4 to
32.5 DN, about 2%. The ringing at a hard occulting edge appears to be intrinsic
to reconstructing a step from band-limited data, not something these priors
remove. They are kept because each is physically correct — a clipped pixel really
does only bound the truth from below, and the Moon's shadow really is dark — but
the expected win did not materialise, and the table says so.

The ringing metric itself is trustworthy on a crescent and **not** on totality,
where it returns a degenerate zero because the corona falls off outward and the
far-field "plateau" is dimmer than the near-limb signal. It is reported only
where the geometry suits it.

### Defocus versus seeing, told apart by shape

Kurtosis of the line-spread function separates the two kinds of blur, and it
does so cleanly on real footage:

| clip | FWHM | kurtosis | verdict |
|---|---|---|---|
| C0082, partial eclipse, in focus | 9.8 px | **4.28** | heavy-tailed — seeing |
| C0092, totality, poor focus | 21–31 px | **1.93** | flat-topped — defocus |

An ideal uniform disc of confusion projects to a kurtosis of 1.80 and a gaussian
to 3.00, so 1.93 is essentially at the defocus limit. That verdict is robust in
a useful direction: any error in the fitted limb circle smears the averaged edge,
and smearing convolves the profile *towards* a gaussian, pushing kurtosis up. A
measurement of 1.93 despite that means the underlying PSF is at least this
flat-topped, and probably flatter.

The absolute width is less certain than the shape. Measured from a single frame
the same clip reads 21 px FWHM, and from a 60-frame mean 31 px, because at a
30 px-wide edge the fitted radius is poorly localised and the two methods
disagree by about 30%. The shape verdict is stable across both; the width is not.

**Totality needs its own limb finder.** The bright region is an annulus of corona
around a dark Moon, so its centroid sits at the Moon's centre and the
inside/outside sense test that separates the solar and lunar limbs cannot
discriminate — both boundaries enclose the centroid, and every candidate is
rejected. The lunar limb is then the *inner* boundary, and fitting those points
alone recovers it. It is the only geometry here where the disc of interest is
the dark one.

### Wavelet sharpening

The à trous scheme Registax made standard. The image is split into octave bands
by repeated blurring — `detail_i = blur_{i-1} - blur_i`, with `blur_n` as the
residual — and reconstructed as `residual + sum(gain_i * detail_i)`.

With every gain at 1 the reconstruction is exact. That is the property worth
testing, and it is: worst absolute difference **0.00e+0** against the input. The
decomposition loses nothing, so the gains alone decide the result.

The advantage over an unsharp mask is control. One unsharp radius amplifies a
single scale and drags noise up with it; here the ~1 px band, where sensor and
codec noise mostly live, can be held at or below 1.0 while the ~2 and ~4 px bands
carrying real solar structure are lifted. Sharpening is applied to the linear
stack before the stretch, not after, so it is not working on a tone curve that
has already compressed the highlights.

It re-renders from the finished stack — **181 ms** at 1400 px — so the sliders
are interactive and cost no re-stacking.

### Clipping the time range

The run is linear in frames, so half the clip is half the wait. Start and end
times are settable before stacking, which is both the fastest way to iterate on
sharpening and stretch settings and the way to skip a passing cloud or the moment
the mount was nudged. Both passes use the same range, and the extractor seeks
before playing — starting playback and seeking together can deliver a frame from
the old position before the seek lands.

### Coverage-weighted accumulation

`warpAffine` fills everything outside the source frame with zeros. Summing those
as though they were measurements darkens whatever a frame did not cover, and on
a clip that drifts — 580 px over 27 s on the eclipse footage — that is a large
part of the canvas.

Measured over 40 eclipse frames, with both normalisations taken from the same
run:

| region | share of canvas | mean error in the old accumulation |
|---|---|---|
| covered by every frame | 82.2% | **0.0000 DN** |
| covered by only some frames | 17.8% | 0.39 DN, up to 11.4 DN |

Against a stack noise floor of about 0.19 DN, an 11 DN error is not subtle. The
fully-covered figure being exactly zero is the control: the fix changes nothing
where nothing was wrong. Coverage is computed by inverting the affine and testing
bounds rather than warping a second mask — exact for an affine map, two adds per
pixel, and validated against a warped mask to within one boundary pixel.

Note this is invisible to the split-half statistics, which are measured over the
eroded inner disc and therefore only ever look at fully-covered pixels. A metric
that cannot see a defect is not evidence the defect is absent.

### Speed

Pass 2, profiled per stage at 2100 px canvas with 182 alignment points:

| stage | before | after |
|---|---|---|
| building the two map Mats | **222.9 ms** | 3.6 ms |
| measuring the field (182 patches) | 74.8 | 73.2 |
| affine warp | 69.6 | 69.7 |
| remap | 67.6 | 68.3 |
| accumulate | 22.3 | 19.3 |
| densify | 15.6 | 15.9 |
| coverage | 5.2 | 5.7 |
| **total per frame** | **478 ms** | **256 ms** |

Nearly half of the second pass was `cv.matFromArray(..., Array.from(f32))`,
which boxes 4.4 million floats into a regular JavaScript array before copying
them in. Writing into `data32F` is a memcpy, and the Mats are now allocated once
and refilled. End to end on 30 frames: 24 s to 18 s, with pass 2 alone 1.8x
faster and results unchanged (fine-band gain 1.250x against 1.249x before).

Accumulators are `Float32Array` rather than `Float64Array`: 8-bit samples summed
over at most 65535 frames peak near 16.7 million, inside Float32's exact-integer
range, so this is lossless and halves the memory. Verified: 1140 frames of 255
sums to exactly 290700.

What remains is close to the floor for this canvas size. Warp, remap and field
measurement are each about 27% and all scale with area, so the effective lever
now is the output size — 1400 px instead of 2100 is 2.25x less work.

### The coarse stage is not the limiting factor

Four coarse registration methods were tried against a partial eclipse — a
crescent, clipped by the sensor, drifting 580 px in 27 seconds — because that is
the case where a centre-of-mass estimate should be at its worst.

| method | ECC left to fix | final fine r | final coarse r |
|---|---|---|---|
| centroid | 2.23 px | 0.1437 | 0.8815 |
| solar limb circle | 7.49 px | 0.1411 | 0.8825 |
| cross-correlation | 3.24–3.30 px | — | — |
| phase correlation | fails | — | — |

Matched at 60 frames, centroid and limb produce stacks that agree to three or
four decimal places in every band. The limb fit is *geometrically* the correct
answer — the centroid sits 430 px from the true solar centre on a crescent, and
migrates as the Moon advances — but ECC absorbs the difference and the finished
image does not care.

So the coarse stage earns robustness, not quality. It matters only when ECC
cannot converge at all: building the reference with a different coarse method
from the frames put every frame an entire disc-width from the reference and
failed ECC on 100% of frames. Fixing that took the failure rate to zero.

The practical rule is therefore a fallback rather than a quality selector: use
the centroid, and switch to the limb fit if the ECC failure rate is high.
Choosing between methods on final quality would be selecting on noise.

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
