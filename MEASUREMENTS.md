# SolFuse — measurement log

Every claim in the [README](README.md) traces back to a measurement here,
including the ones that turned out wrong. See [VISION.md](VISION.md) for the
design.

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

Split-half SNR alone cannot answer this question. Blur is reproducible: adding blurrier frames lowers noise and raises `r`. An SNR curve would suggest using all frames, regardless of seeing variation. The `√r` factor reduces the noise impact. `rms_fine` drops when blurred frames dilute detail. The product peaks at the true balance point.

Measured on 60 frames of C0013:

| keep | frames | r | rms | A |
|---|---|---|---|---|
| 10% | 6 | 0.9978 | 6.719 | 6.712 |
| 25% | 15 | 0.9991 | 6.773 | 6.770 |
| 50% | 30 | 0.9997 | 6.792 | 6.791 |
| all | 60 | 0.9999 | 6.845 | **6.845** |

Monotonic to 100%: averaging wins outright, and the gain from selecting is ×1.000. This matches the earlier finding that selection buys about 1%, reached by a different measure. Two independent methods give the same answer.

One caveat on reading the curve: on a high-contrast target `r` saturates near 1, as it does above, so the comparison is carried almost entirely by `rms` and the `√r` term does little work. On noisier footage, or a fainter target, it matters much more. The curve costs about 13% on pass 1 and can be turned off.

## Measured behaviour

All figures come from **C0013.MP4**: 1140 frames of real 4K solar video, 25 fps, 52 Mbps H.264, disc ~1870 px across, shot through a dense solar ND filter.

### Multi-point alignment is the win

Split-half reliability — odd frames stacked separately from even frames, so reproducible structure appears in both halves and noise does not:

| band | global align | multi-point | SNR gain |
|---|---|---|---|
| fine (1.4–3.2 px) | r = 0.9855 | r = 0.9891 | **1.34×** |
| mid (3–7 px) | r = 0.9967 | r = 0.9976 | **1.34×** |
| coarse (7–15 px) | r = 0.9985 | r = 0.9990 | **1.49×** |

Reproducible fine-detail amplitude rises **9.8%**. The distortion being corrected measures **1.33 px mean, 2.03 px at p95**. This is small but comparable to the scale of the detail itself, which is why removing it matters.

Against a single frame, stacking cuts high-frequency noise to **0.106×** (a 9.4× reduction).

### Frame selection is not worth shipping

The lucky-imaging premise, tested against a seeded random control of identical size:

| stack | noise | mid-detail | detail/noise |
|---|---|---|---|
| best 25%, raw band energy | 0.104 | 0.286 | 2.75 |
| best 25%, noise-normalised | 0.089 | 0.250 | 2.80 |
| random 25% (control) | 0.083 | 0.230 | 2.77 |
| all 1140 frames | 0.076 | 0.229 | **3.01** |

Selection gains **1.0%** over its own control at best. Stacking all methods beats every subset. The first metric was worse than useless. It selected frames with 24% more "detail" *and* 25% more noise. It ranked by total high-frequency energy and picked the grainiest frames.

### The naive sharpness metric grades the codec

Laplacian energy inside the disc across 3720 frames of C0014, split by H.264 picture type:

| metric | I | P | B | composition of the best 10% |
|---|---|---|---|---|
| raw Laplacian | 31.1 | 32.8 | 38.9 | **B 99%**, I 0%, P 0% |
| difference-of-Gaussians | 0.7 | 0.7 | 0.7 | I 22%, P 43%, B 34% |
| blurred gradient | 42.3 | 41.8 | 40.7 | I 24%, P 45%, B 29% |

B-frames make up 66% of the population. The raw metric selects "the B-frames". Autocorrelation shows a 12-frame GOP period. Dips appear at lag 5. Values rise at lags 10 and 25. Band-limiting removes the dependence.

### Why selection fails here, physically

**This section previously said the ND filter forces a long exposure that time-averages the seeing inside each frame. That was wrong**, and the numbers say so. Ian's stated capture is 20 stops of ND at f/11 and ISO 800. Solar disc luminance at ground level is about 1.6e9 cd/m2. Through 20 stops it is 1.5e3 cd/m2. The correct exposure is

    t = N^2 K / (L S) = 121 * 12.5 / (1524 * 800) = 1.2 ms

A solar filter does not force a long exposure. The sun is bright enough that 20 stops still leaves you at 1/800 s. At 1.2 ms, the shutter is *shorter* than the atmospheric coherence time. This freezes the seeing in each frame instead of averaging it. The old explanation described the opposite of what happened.

The real reason is the aperture, and the footage shows it. The fitted solar radius is 931.7 px against a 1919 arcsec disc, giving 1.03 arcsec/px. With a 1-inch sensor at full-width 4K, that is a 689 mm focal length. So f/11 means **D = 63 mm**. Noll gives the wavefront error left after tip and tilt are removed:

    sigma^2 = 0.134 (D/r0)^(5/3) rad^2

At r0 = 5 cm, the value is 0.19 rad^2 -- **a Strehl ratio of 0.82**. The frames are near diffraction-limited (lambda/D = 1.81 arcsec = 1.76 px, against 1.1-3.7 px of free-air seeing). Sharpness variation is minimal, so selection has little to choose from. At this aperture, the atmosphere mostly *moves* the image. Tip and tilt carry 87% of the total wavefront variance, and alignment removes that. The predicted tilt is 0.5-1.4 px rms for r0 = 3-10 cm. The harness measures a 0.72 px displacement field. This puts r0 around 5-7 cm, confirming the model is in the right regime.

Lucky imaging pays when D/r0 is large. `tools/seeing-study.js` runs the model across apertures with tilt removed. Only blur varies:

| aperture | D/r0 | Strehl | sharpness spread | selection gain |
|---|---|---|---|---|
| 63 mm (this footage) | 1.25 | 0.823 | 30.9% | 1.039x |
| 100 mm | 2.00 | 0.653 | 24.5% | 1.039x |
| 150 mm | 3.00 | 0.433 | 43.8% | 1.064x |
| 300 mm | 6.00 | 0.070 | 54.7% | 1.110x |

**Honest gap:** the model predicts 1.039x at this aperture, but the footage measures 1.000x. At r0 = 10 cm, the model gives 1.013x, which is much closer. However, the 0.72 px tilt points to r0 nearer 5-7 cm, so the two estimates disagree. The model brackets the answer at 1.3-3.9% against a measured 1% or less. It has the regime right and overstates the size. This is what an 18-mode Zernike truncation with a chosen rather than derived temporal decorrelation would do. Do not read it as confirmation, only as consistency.

So the advice stands, but for a different reason: **a bigger aperture is what would make lucky imaging pay here, not a faster shutter.** The shutter is already fast enough.

### Two things this measurement got wrong

Recorded because both were caught by checking rather than by reasoning, and both would otherwise have shipped as facts.

**The displacement field was inflated by cells that measured nothing.** Only about 40% of grid cells carry a locatable alignment point — 182 of 441 on a 4K disc. The rest were filled by propagating the nearest measurement outward with no decay. This invents motion over empty sky beyond the limb. Measured cells carried a median 0.32 px displacement; the filled ones carried 0.74 px, more than double. The field is now tapered to zero within 2.5 grid steps of the last real measurement. This halves the reported magnitude (2.24 → 1.12 px median on 300 frames) and makes the number mean what it says.

**The coarse-band SNR ratio was never evidence.** A full 1140-frame run showed multi-point alignment scoring 0.938× against global alignment in the 7–15 px band — apparently worse. The taper above was the obvious suspect, so it was A/B tested at 300 frames: with and without, the coarse gain came out 1.193× against 1.194×. The taper was not the cause.

The real cause is the metric. `SNR = r/(1−r)` diverges as r approaches 1. The coarse band sat at r = 0.9984 against 0.9983 — a difference of 1×10⁻⁴, amplified into a 6% swing. Correlations above about 0.995 carry no usable information in this form, in either direction. They are now flagged as such wherever they are reported. The fine band, where r runs 0.96–0.99, is the one to read: it gives 1.24× at 300 frames and 1.31× at 1140, against the Python prototype's 1.34×.

### Why registration is a centroid and not a correlation

The obvious objection to locating the disc by its centre of mass is that it breaks when the lit region is clipped by the frame edge, or when the Moon eats half the disc. Cross-correlation looks like the more robust answer. Measured on 684 frames of a partial eclipse — a deep crescent, clipped at the bottom of the sensor, drifting 580 px in 27 seconds — it is not.

Judged by how much ECC has to correct afterwards, and the correlation ECC reaches:

| coarse method | ECC left to fix | p90 | ECC correlation | failures |
|---|---|---|---|---|
| centroid | **2.23 px** | 4.85 | 0.99938 | 0 |
| cross-correlation @ 1/8 | 3.26 px | 8.10 | 0.99937 | 0 |
| cross-correlation @ 1/4 | 3.30 px | 8.28 | 0.99939 | 0 |
| cross-correlation @ 1/2 | 3.24 px | 8.29 | 0.99938 | 0 |

The correlation peak is intrinsically broad, not due to sub-pixel quantisation. A crescent is a large, smooth, low-texture blob. Correlating it against itself creates a wide plateau with no features for a sub-pixel fit to use. The centroid method wins because it is an *integral* estimator. It averages over ~850,000 lit pixels of a high-contrast object on a black background.

**Phase correlation performs worse, which is instructive.** The code was hand-rolled from `dft`. The build lacks `phaseCorrelate`, `mulSpectrums`, and `idft`. Validation on deltas shows it is exact: an 8x8 image shifted by (+3, +2) places the peak at (5, 6), the correct wrapped position. On the crescent, it returns zero shift every time. Sweeping the whitening from full to none:

| whitening | worst error |
|---|---|
| full (pure phase correlation) | 14.2 px |
| 0.1 | 5.8 px |
| 1 | 3.6 px |
| 10 (approaching plain cross-correlation) | 2.0 px |

Accuracy improves as whitening decreases. Phase correlation assumes a broadband spectrum. A delta function has one, so every bin carries signal. A smooth crescent's spectrum decays fast, and most high-frequency bins hold only numerical noise. Whitening rescales that noise to unit magnitude alongside the real content, swamping the phase ramp.

Phase correlation would work well for a star field, where the image is a sum of deltas. That is AstroFuse's problem, and it needs rotation, which plain phase correlation does not provide.

On this footage, the choice barely matters. Every method reached ECC correlation 0.99938 with zero failures. The coarse stage is not the bottleneck. The framing is.

### Deconvolution, with the PSF measured rather than assumed

A limb is a step edge of known geometry, so its edge-spread function gives the point spread function directly. No parametric family is assumed, and no PSF is optimised against a sharpness score. A sharpness score would converge on amplified noise.

Two details decide whether the answer is usable. Both were found by checking rather than reasoning:

**Normalise each profile before averaging.** Limb darkening means the photosphere behind one part of the arc is not as bright as behind another. Binning by radius alone mixes those plateaux and smears the edge. It measured the blur 37% too wide, and the recovered PSF failed to re-project onto its own data. Rescaling each profile to its own dark and bright levels first took the re-projection error from **18.4% to 4.0%** and the FWHM from 14.28 to 10.45 px.

**Prefer the lunar limb.** The Moon has no atmosphere and no limb darkening. During an eclipse, it is very nearly an ideal knife edge laid across the brightest object in the sky. Measured on the same stack, the solar limb reads **1.44x wider**. That excess is limb darkening, not blur.

Recovery uses MTF rather than fitting. For a radially symmetric system, the MTF is the magnitude of the Fourier transform of the line-spread function. Rotating it into a 2D transfer function and inverting gives the PSF whatever its shape. A disc-convolved-gaussian fit was tried first and left a 17% residual. The transform route is assumption-free and validated by re-projection.

Measured on the eclipse stack: **FWHM 9.81 px, sigma 4.17 px, kurtosis 4.28** from 1502 averaged edge profiles, in 408 ms. Kurtosis is the useful diagnostic: 3.0 is gaussian, ~2.0–2.3 is the flat-topped disc of pure defocus, and above 3.6 is the heavy-tailed profile of seeing. This clip is seeing-limited, not focus-limited.

**Richardson–Lucy rings at hard edges, and it is not subtle.** At 20 iterations on the eclipse crescent, the lunar limb grows a bright overshoot line and the dark lunar disc mottles visibly. Most of a 36 DN mean change was that artefact rather than recovered detail. Deconvolution is off by default, capped in the UI, and carries the warning. A full disc, whose only hard edge is the sun's own limb, tolerates far more than an occulted one does. 20 iterations at 2100 px with a 41x41 kernel takes about 3.5 s.

### Deconvolution works, at two iterations

Two corrections to what this file said earlier, both mine.

**Split-half cannot validate a deconvolution.** Deconvolving the odd- and even-frame half-stacks independently and measuring A = sqrt(r) x rms reported that 40 iterations improved the fine band by **112x**. This is not credible. The reason is structural: deconvolution artefacts are a deterministic function of the underlying structure, which both halves share. Ringing correlates exactly as well as real detail. Split-half separates *random* error from signal and is blind to *systematic* error. It was the right tool for multi-point alignment and the wrong one here. Ground truth is the only thing that answers this.

**The earlier verdict of "does not work" was wrong, and the fault was in the sampling.** Tested at 5, 10, 20 and 40 iterations, every setting was worse than not deconvolving, so it looked broken. The useful range is 1 to 4:

| iterations | RMSE vs truth | fine-band r with truth |
|---|---|---|
| blurred input | 2.634 | 0.9697 |
| 1 | 1.954 | 0.9750 |
| **2** | **1.424** | **0.9774** |
| 3 | 1.542 | 0.9756 |
| 4 | 2.441 | — |
| 5 | 3.770 | worse than blurred |
| 20 | 42.2 | catastrophic |

At two iterations, error drops by **1.85x**. Correlation to the truth also rises. This shows the method recovers detail rather than creating it. The code was sound, but this clue was missed. An RL loop started *at* the truth stayed there exactly. The ratio and correction were both 1.0000. A broken loop would not behave this way.

The range is narrow because deconvolution is ill-posed. The PSF response near Nyquist is very small. Amplifying it by the required factor magnifies float32 rounding error without limit. Adding noise at sigma 0, 0.2, and 1.0 barely moves the optimum. Ill-posedness, not noise, sets the optimum.

**Total variation, as implemented here, makes things worse** at every iteration count. RMSE rises from 2.81 to 3.09, compared to 1.43 without it. Correlation to the truth drops from 0.977 to 0.80. The control has been removed rather than left as a trap.

### Deconvolution stability, and what the anti-ringing measures were worth

**The deconvolution first released was diverging, not ringing.** Richardson–Lucy divides by the blurred estimate. In a dark sky, this estimate tends to zero. With a 1e-6 epsilon, the ratio explodes. The result reached 900 DN of "overshoot" on an 8-bit image. What looked like catastrophic ringing was a numerical blow-up.

Three guards fix this: an epsilon scaled to the data rather than fixed, a cap on the per-iteration ratio, and a physical ceiling on the estimate. The last one matters most. Capping the ratio at 4 still permits 4^20 over a 20-iteration run. With all three guards, output stays bounded. The mean goes from 44.2 to 40.1 DN over 20 iterations, with 5% of pixels reaching the ceiling.

Ringing is measured rather than eyeballed. This is done by sampling the radial profile across the fitted limb and taking the overshoot above the local plateau:

| variant | overshoot | in sigma |
|---|---|---|
| stacked, no deconvolution | 1.01 DN | 1.2 |
| plain RL, 20 iterations | 33.35 | 2.2 |
| + saturation masking | 34.58 | 2.5 |
| + support constraint | 35.53 | 2.5 |
| + TV, lambda 0.002 | 33.06 | 3.4 |
| + TV, lambda 0.01 | 32.50 | 4.2 |

**Honest result: none of them helps much here.** Overshoot drops from 33.4 to 32.5 DN, a 2% change. The ringing at a hard occulting edge is intrinsic to reconstructing a step from band-limited data. These priors do not remove it. We keep them because each is physically correct. A clipped pixel only bounds the truth from below, and the Moon's shadow is dark. The expected win did not happen, and the table shows this.

The ringing metric is trustworthy on a crescent and **not** on totality. On totality, it returns a degenerate zero because the corona falls off outward and the far-field "plateau" is dimmer than the near-limb signal. We report it only where the geometry suits it.

## Colour

Colour is off by default. The default is the measured answer, not a guess.

Alignment, the PSF, deconvolution, the trade-off curve, and every statistic run on green exactly as they do in mono. The green plane the worker receives is a zero-copy subarray of the planar frame and is byte-identical to the grayscale a mono run sends. Red and blue use the same affine and the same displacement field. Measuring the field per channel costs three times as much and can disagree between channels. This disagreement creates colour fringing.

### Whether it is worth turning on depends entirely on the footage

| clip | mean R | mean G | mean B | channels identical | median saturation |
|---|---|---|---|---|---|
| C0013 white light | 179.9 | 179.9 | 179.9 | **100.0%** of lit pixels | 0.0% |
| C0092 totality | 181.8 | 123.4 | 79.5 | 2.0% | 62.9% |

The white-light clip is **bit-identical across all three channels in every lit pixel**. It is not approximately grey. Colour mode on that footage costs three times the transfer to reproduce the mono result exactly. Totality is the opposite: prominences are H-alpha red and the corona is not neutral either.

The app measures this and tells you which case you have. This prevents you from wondering why your stack came out grey.

### The composite is LRGB

Luminance carries all processing: stacking, deconvolution, wavelets, and sharpening. Colour applies on top as a ratio. By default, this ratio is low-passed with a 3 px Gaussian.

Avoid sharpening chroma. Colour noise is largely uncorrelated between channels. High-passing the ratios turns this noise into coloured speckle. Soft colour reads better than noisy colour. Blurring costs nothing visible on a solar disc because sharp structure is all luminance. The test measures this: blurring the ratios cuts the channel spread by more than half while the luminance stays within 2 DN of the mono render.

The ratios use the **raw** stacked green, not the sharpened luminance. Using processed green would set deconvolution overshoot against unsharpened red and blue, causing fringing on every edge.

### The colour statistic needed fixing before it could be trusted

The first version used an absolute 8 DN gate and reported **51.8% median saturation for a corona that is close to white**. The totality clip has a blue pedestal in the dark sky. Blue clears 8 DN in 88% of pixels where green clears it in 19%. The gate admitted the whole sky. Saturation is a ratio, so a couple of DN of channel offset on a near-black pixel reads as almost fully saturated. The threshold now scales with the image (10% of the bright end). The tests cover this exact case.

**The median alone is also the wrong thing to report**. A white-light disc with one vivid prominence is neutral over almost all its area. The median sits near zero, but the feature colour mode exists for is present. The verdict now consults the high end. In the worker smoke test, a small red patch gives median 0.0% and p95 70.9%.

### Cost

Two extra Float32 planes add **+33.6 MB** at canvas 2100. Red and blue share the green stack's per-pixel counts rather than carrying their own, since coverage is identical across channels. Per frame, the second pass includes two extra warps and two extra remaps.

The harness measures C0092 at 40 frames, going from 11+10 s to 34+45 s. Most of this is not the app's cost. Pass 1 does no extra OpenCV work in colour mode. Its 11->34 s increase is entirely ffmpeg's `gbrp` decode and three times the pipe throughput. A browser decodes to RGBA either way. The honest figure for the browser is the extra warps and remaps in pass 2, plus a planar extraction and three times the transfer per frame.

**Caveat on that comparison:** the harness reads `-pix_fmt gray` in mono, which is luma, and `gbrp` plane 0 in colour, which is green. The app always uses green. For C0013, the two are identical because the footage is monochrome. Every mono number in this README is unaffected. On coloured footage, they differ. This is why the two runs above report different alignment-point counts.

### tools/smoke-worker.js

The pipeline functions have unit tests. The plumbing between them does not. This is where colour mode goes wrong: unpacking planar frames, routing red and blue through the right transform, and picking the right renderer at finish. `node tools/smoke-worker.js` drives the real `worker.js` under a node worker shim in both modes. It checks that mono comes out grey, that colour puts the red where the red is and nowhere else, and that the strided-read guard stays silent.

## Unit tests, and the three bugs they found

`node tools/test-pipeline.js` runs 46 tests with 240 checks. It has no dependencies. Each test constructs an input with a known analytical output or checks against an independent slower computation (brute-force coverage, direct convolution). This prevents regressions from being approved by updating a golden number.

Every bug this project hit before was found by accident: a stack that looked wrong, a statistic that moved the wrong way, a user reporting 188 dropped frames. Writing tests found three more bugs. One of these invalidated a headline measurement.

### The sharpness metric was non-monotonic in blur

`frameQuality` ranked frames on fine-band energy over a *noise-band* (1.4-3.2 over 0.6-1.2). Blurring suppresses the 0.6-1.2 band faster than 1.4-3.2. This caused the ratio to **rise** with blur unless noise held the denominator up. On a textured synthetic disc, with noise added after the blur as a sensor does:

| sensor noise | blur 0 | blur 1.0 | blur 2.5 | |
|---|---|---|---|---|
| sigma 0 | 4.18 | 8.50 | 24.71 | backwards |
| sigma 2 | 3.16 | **4.49** | 3.32 | peaks at 1.0 px |
| sigma 4 | 2.00 | **2.14** | 1.18 | peaks at 1.0 px |
| sigma 8 | **0.94** | 0.85 | 0.48 | correct |

Consecutive aligned frames of the real footage differ by **sigma 1.05 DN**. The metric operated in its backwards regime on the material it was designed for, ranking a 1 px-blurred frame above a sharp one. It is now fine-over-mid (1.4-3.2 over 3.2-7.0). Both bands are signal-dominated. The ratio falls monotonically with blur at every noise level tested. It remains invariant to contrast.

The test that catches this works only because the noise is applied *after* the blur. Blurring an already-noisy frame suppresses the noise. This flatters any metric that divides by a noise-dominated band. This is how the original passed inspection.

### The trade-off curve was measured on a scrambled image

`accumulateCurve` read its region of interest with `new Uint8Array(roi.data)`. A submatrix keeps its parent's row stride and reports `isContinuous` false. The `.data` accessor **ignores stride**: it returns `total() * elemSize()` bytes straight from the ROI origin. For a 512-wide window on a 2100-wide canvas, this is 125 parent rows chopped into 512-px strips, sweeping across each row four times. The curve was computed on that.

It still looked like plausible data, so nothing downstream complained. It just stopped responding to sharpness. On synthetic frames where selecting the best 25% demonstrably improves fine detail by 17%, the curve reported 0.3%.

`tools/strided-guard.js` wraps the `.data` getters and reports any read from a Mat whose rows are not contiguous. Running the whole suite under it reports none. The same guard was run against **AstroFuse** (its headless harness) and **BracketFuse** (its real worker under a node shim). Both are clean. Neither takes a submatrix anywhere. The bug class is absent there rather than merely unobserved.

Worth knowing for the rest of the codebase: **`clone()` does not fix this.** A cloned ROI is correct for OpenCV operations. `ucharPtr` and `reduce` both read it properly. It still reports the parent stride, so `.data` is still wrong. `copyTo` into a fresh Mat is the fix. This was the only such site. Everywhere else reads `.data` from full-size continuous Mats.

### Weights on an integer accumulator silently produced black

`newAccumulator(canvas, halves)` counts in Uint16. `cnt += 0.75` truncates to zero. `finishAcc` then divides a real sum by nothing. The stack comes out uniformly black with no error raised anywhere. It now throws.

### What the fixes changed

Both measurements were re-run. **The headline conclusion survives**. It now rests on numbers that mean something:

| keep | frames | r | rms | A |
|---|---|---|---|---|
| 5% | 15 | 0.940 | 1.212 | 1.175 |
| 25% | 75 | 0.991 | 1.278 | 1.273 |
| 100% | 300 | 0.998 | 1.390 | **1.389** |

Before the fix, `rms` was ~6.8 (scrambled) and `r` was saturated at 0.9999. Now `r` spans 0.94-0.998 and discriminates. A unit test proves the curve detects a sharpness difference when one exists. Stacking everything still wins.

## The atmospheric model

`tools/seeing.js` is a Kolmogorov seeing model matched to this footage. Every claim about alignment is a claim about atmospheric distortion. The tests only applied a uniform shift, which is the one case multi-point alignment is not for.

It generates a smoothly varying displacement field with the ground truth for it. It also generates a per-field-point PSF from Zernike modes 4-21 with Noll variances. Frozen flow means angular and temporal decorrelation come from one mechanism. Parameters are derived in the file: 1.03 arcsec/px, D = 63 mm, 25 fps, 1.2 ms.

One parameter matters more than the rest. **Daytime solar seeing is ground-layer dominated**. It is not set by the high layers that give the 2-4 arcsec isoplanatic angle quoted for nighttime astronomy. At 3 arcsec, the layer sits at 1.1 km. Tilt decorrelates over 12 px. An 80 px alignment patch averages seven independent cells into mush. Multi-point alignment could not work at all. At 20 arcsec, the layer is at 160 m. Tilt stays coherent over 77 px. A 100 px grid can track this. The footage shows a coherent field, so the ground-layer value is the right one.

This buys the first ground-truth test of the project's core claim: **multi-point alignment lands closer to the true undistorted scene than global alignment does.** Split-half reliability could never show that. It says how reproducible a stack is, not how close to correct.

### Weighting the stack on local seeing, and why it is off

The displacement field already grades every part of every frame. Weighting each patch by how sharp it is there looks like the sophisticated form of lucky imaging. Seeing is local. Discarding a whole frame throws away its good half along with its bad one. We built this (`--seeing P` in the harness, exponent `P` on the per-cell quality ratio), measured it, and left it off by default because it loses.

Quality per cell is the mid-band over high-band energy ratio. We grade it against the 80th percentile of the *same cell across frames*. We never grade it against other cells in the same frame. That would only rediscover that the disc centre has more contrast than the limb.

| exponent | fine gain | mid gain |
|---|---|---|
| 0 (off) | 1.245x | 1.161x |
| 1 | **1.247x** | 1.161x |
| 2 | 1.245x | 1.161x |

Flat. **These are the numbers after the sharpness metric was fixed**; measured
with the old metric it was monotonically worse (1.267x down to 1.092x), which
was the metric mis-ranking frames rather than weighting being harmful. The reason is not that local weighting is a bad idea but that
**the metric is not measuring the atmosphere**. Seeing evolves over tens of
milliseconds, so at 60 fps adjacent frames sit well inside its coherence time
and a real signal has to correlate between them. Autocorrelation of the per-cell
quality series says otherwise:

| clip | lag 1 | lag 2 | lag 3 | lag 4 |
|---|---|---|---|---|
| C0013 full disc | 0.081 | -0.008 | **0.412** | -0.080 |
| C0092 totality | 0.167 | 0.052 | 0.095 | 0.094 |

C0013 spikes at lag 3, the GOP period. The metric mostly grades H.264 picture type. This is the same trap the raw Laplacian fell into. Band-limiting only partly suppresses it. C0092 shows weak decay with no structure. It is noise. Neither metric shows the strong short-lag correlation that real seeing would produce.

The earlier whole-frame result holds locally for the same physical reason. A dense solar ND filter forces a long exposure. This averages the seeing *inside* each frame. Little frame-to-frame variation remains for any metric to find. This costs 217 ms/frame. A 1140-frame clip takes roughly four minutes.

**It is kept, not deleted**, because the diagnostic is useful. Shoot manual at the fastest shutter the filter allows. The lag-1 correlation tells you whether weighting will pay. Check this before raising the exponent.

### Alignment points on a corona

Masking at 0.45 of peak brightness and eroding by 61 px works for a bright full disc but fails at totality. The threshold keeps only a thin ring of inner corona. Eroding a thin ring by that much leaves almost nothing: **6 points on a 21x21 grid**. Multi-point alignment had nothing to work with. The erosion keeps patches off the solar limb, where half the patch is empty sky. A fainter, thinner target needs a proportionally smaller guard band.

Both now step down a ladder until enough points survive. On a 120-frame totality stack, this takes 6 points to **26**. 25 of 26 locate per frame.

Measured like for like at the same frame count, the benefit is modest:

| | points | fine gain | mid gain |
|---|---|---|---|
| single rung (old) | 6 | 1.036x | 1.001x |
| ladder | 26 | 1.030x | 1.026x |

The fine band stays the same. The mid band improves slightly. Totality has little fine structure in the corona to correct, so wider coverage adds little value. However, a six-point field cannot describe differential distortion. Fixing this is valuable regardless of the clip. The full-disc case remains unchanged. The ladder stops at the first rung with 183 points and the same 1.250x gain as before.

### Defocus versus seeing, told apart by shape

Kurtosis of the line-spread function separates the two kinds of blur. It does so cleanly on real footage:

| clip | FWHM | kurtosis | verdict |
|---|---|---|---|
| C0082, partial eclipse, in focus | 9.8 px | **4.28** | heavy-tailed — seeing |
| C0092, totality, poor focus | 21–31 px | **1.93** | flat-topped — defocus |

An ideal uniform disc of confusion projects to a kurtosis of 1.80, and a gaussian to 3.00. A value of 1.93 is essentially at the defocus limit. This verdict is robust in a useful direction: any error in the fitted limb circle smears the averaged edge. Smearing convolves the profile *towards* a gaussian, pushing kurtosis up. A measurement of 1.93 despite this means the underlying PSF is at least this flat-topped, and probably flatter.

The absolute width is less certain than the shape. Measured from a single frame, the same clip reads 21 px FWHM. From a 60-frame mean, it reads 31 px. At a 30 px-wide edge, the fitted radius is poorly localised, and the two methods disagree by about 30%. The shape verdict is stable across both; the width is not.

**Totality needs its own limb finder.** The bright region is an annulus of corona around a dark Moon. Its centroid sits at the Moon's centre. The inside/outside sense test that separates the solar and lunar limbs cannot discriminate. Both boundaries enclose the centroid, and every candidate is rejected. The lunar limb is then the *inner* boundary. Fitting those points alone recovers it. It is the only geometry here where the disc of interest is the dark one.

### Wavelet sharpening

The à trous scheme Registax made standard. The image is split into octave bands by repeated blurring — `detail_i = blur_{i-1} - blur_i`, with `blur_n` as the residual — and reconstructed as `residual + sum(gain_i * detail_i)`.

With every gain at 1, the reconstruction is exact. That is the property worth testing, and it is: worst absolute difference **0.00e+0** against the input. The decomposition loses nothing, so the gains alone decide the result.

The advantage over an unsharp mask is control. One unsharp radius amplifies a single scale and drags noise up with it. Here, the ~1 px band, where sensor and codec noise mostly live, can be held at or below 1.0. The ~2 and ~4 px bands carrying real solar structure are lifted. Sharpening is applied to the linear stack before the stretch, not after. It does not work on a tone curve that has already compressed the highlights.

It re-renders from the finished stack — **181 ms** at 1400 px. The sliders are interactive and cost no re-stacking.

### Clipping the time range

The run is linear in frames. Half the clip is half the wait. Start and end times are settable before stacking. This is the fastest way to iterate on sharpening and stretch settings. It is also the way to skip a passing cloud or the moment the mount was nudged. Both passes use the same range. The extractor seeks before playing. Starting playback and seeking together can deliver a frame from the old position before the seek lands.

### Coverage-weighted accumulation

`warpAffine` fills everything outside the source frame with zeros. Summing those as though they were measurements darkens whatever a frame did not cover. On a clip that drifts — 580 px over 27 s on the eclipse footage — that is a large part of the canvas.

Measured over 40 eclipse frames, with both normalisations taken from the same run:

| region | share of canvas | mean error in the old accumulation |
|---|---|---|
| covered by every frame | 82.2% | **0.0000 DN** |
| covered by only some frames | 17.8% | 0.39 DN, up to 11.4 DN |

An 11 DN error stands out against a stack noise floor of about 0.19 DN. The fully-covered figure is exactly zero, which acts as a control: the fix changes nothing where nothing was wrong. Coverage is computed by inverting the affine and testing bounds, not by warping a second mask. This method is exact for an affine map, uses two adds per pixel, and is validated against a warped mask to within one boundary pixel.

Split-half statistics do not see this issue. They measure over the eroded inner disc and only look at fully-covered pixels. A metric that cannot see a defect does not prove the defect is absent.

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

Half of the second pass used `cv.matFromArray(..., Array.from(f32))`. This boxes 4.4 million floats into a regular JavaScript array before copying them. Writing into `data32F` is a memcpy. The Mats are now allocated once and refilled. End to end on 30 frames, time dropped from 24 s to 18 s. Pass 2 alone is 1.8x faster. Results are unchanged: fine-band gain is 1.250x, compared to 1.249x before.

Accumulators use `Float32Array` instead of `Float64Array`. Summing 8-bit samples over at most 65535 frames peaks near 16.7 million. This is inside Float32's exact-integer range. The change is lossless and halves memory. Verification: 1140 frames of 255 sums to exactly 290700.

Performance is close to the floor for this canvas size. Warp, remap, and field measurement each take about 27% of the time. All scale with area. The main lever now is output size. Using 1400 px instead of 2100 reduces work by 2.25x.

### The coarse stage is not the limiting factor

Four coarse registration methods were tested against a partial eclipse. The eclipse was a crescent, clipped by the sensor, drifting 580 px in 27 seconds. This is the case where a centre-of-mass estimate should be at its worst.

| method | ECC left to fix | final fine r | final coarse r |
|---|---|---|---|
| centroid | 2.23 px | 0.1437 | 0.8815 |
| solar limb circle | 7.49 px | 0.1411 | 0.8825 |
| cross-correlation | 3.24–3.30 px | — | — |
| phase correlation | fails | — | — |

At 60 frames, the centroid and limb methods produce stacks that match to three or four decimal places in every band. The limb fit is *geometrically* the correct answer. The centroid sits 430 px from the true solar centre on a crescent and moves as the Moon advances. ECC absorbs this difference, so the final image is unaffected.

The coarse stage provides robustness, not quality. It only matters when ECC fails to converge. Building the reference with a different coarse method than the frames placed every frame a full disc-width from the reference. This caused ECC to fail on 100% of frames. Fixing this reduced the failure rate to zero.

The practical rule is a fallback, not a quality selector. Use the centroid. Switch to the limb fit if the ECC failure rate is high. Choosing between methods based on final quality is selecting on noise.

### Browser against headless

The browser and the node harness run the same `pipeline.js`. On the same 40 real 4K frames:

| | node | browser |
|---|---|---|
| alignment points | 182 | 182 |
| points used per frame | 168 | 170.7 |
| ECC refinement, median | 1.87 px | 1.90 px |
| displacement field, median | 1.96 px | 2.04 px |
| ECC failures | 0 | 0 |

Small differences are expected. The browser test used JPEG-re-encoded frames because this environment could not provide the video directly. On the full 1140 frames, the node port finds **183 alignment points**, matching the Python prototype exactly.

Browser timings for 40 frames of 4K into a 2100 px canvas on desktop Chrome 142: pass 1 **15.3 s**, pass 2 **25.9 s**, accumulators **235 MB**. Extrapolated, a full 45-second clip takes roughly 20 minutes. The alignment work dominates; video decode at playback speed contributes about 90 seconds of that.

