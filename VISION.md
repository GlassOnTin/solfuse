# VISION — SolFuse

**Stack a solar video into one clean image, entirely in your browser.**

Drop in a clip of the sun through a filter. Get back a single stacked image with
the sensor noise averaged away and the atmosphere's distortion partly undone.
Nothing is uploaded and no account is created.

Fourth project on the BracketFuse chassis. Unlike the others, this VISION was
written *after* the evidence rather than before it: the pipeline was prototyped
in Python against 1140 frames of real 4K solar video first, and only the parts
that measurably worked were carried into the browser. The numbers are in
[MEASUREMENTS.md](MEASUREMENTS.md).

---

## What the measurement changed

Three things the prototype settled, each of which would otherwise have been a
plausible-sounding design decision with nothing behind it.

**Lucky imaging does not work on this footage, and the tool should not pretend
otherwise.** The premise — grade every frame for sharpness, keep the best 10-25%,
discard the rest — is the standard planetary technique. Measured against a
seeded random control of the same size, selecting the best 25% improved the
detail-to-noise ratio by **1%**. Stacking all 1140 frames beat every 25% subset.
So SolFuse stacks everything by default and does not ship a quality slider
implying otherwise.

The reason is physical rather than a flaw in the method. A dark solar filter
forces a long exposure, a high gain, or both. A long exposure time-averages the
seeing *inside each frame*, so the frame-to-frame variation lucky imaging exists
to exploit has already been integrated away before readout. The technique needs
exposures short relative to the atmospheric coherence time, and consumer video
through a dense filter is the opposite of that.

**The obvious sharpness metric grades the codec, not the atmosphere.** Laplacian
energy inside the disc, measured across 3720 frames, split cleanly by H.264
picture type: I-frames 31.1, P-frames 32.8, B-frames 38.9. The "sharpest 10% of
frames" was 99% B-frames, against 66% in the population. Its autocorrelation
even showed the 12-frame GOP period. Band-limiting the metric — a
difference-of-Gaussians keeping mid frequencies, where solar structure lives and
block noise does not — flattens the type dependence completely. Any frame
ranking in this tool must be band-limited or it is ranking the encoder.

**Multi-point alignment is where the gain is.** A single global transform cannot
correct the atmosphere, because different parts of the disc move by different
amounts — measured at 1.3 px mean and 2.0 px at p95 across a 1870 px disc. A
grid of independently-located patches driving a dense displacement field
recovers **+9.8% reproducible fine detail** and **1.34x SNR**, verified by
split-half reliability rather than by a single-stack noise estimate.

That last distinction matters enough to state as a principle: **a
residual-against-median noise estimator cannot tell fine solar detail from
grain.** It reported multi-point alignment as slightly *worse* when it is
materially better, and it reported the frame-selection metric as working when it
was selecting noisy frames. Splitting the frames into two halves and correlating
the resulting stacks separates reproducible signal from noise by construction,
and is the only measurement in this project that has not misled.

---

## Pipeline

```
video -> requestVideoFrameCallback -> green plane
  pass 1:  disc centroid -> ECC refine at quarter scale -> warp to canvas
           -> accumulate                                  (builds the reference)
  pass 2:  warp with the cached transform
           -> ~180 alignment points, matchTemplate + parabolic sub-pixel
           -> fill and smooth the displacement field -> remap
           -> accumulate
  render:  percentile stretch, optional unsharp mask
```

Two passes because multi-point alignment needs a low-noise reference, and the
only way to get one is to stack first. Alignment points cut from a single frame
would fold that frame's noise into every displacement estimate.

Frames are identified by presentation timestamp rather than by a counter, so if
the browser presents a slightly different set on the second pass the transforms
still match up.

---

## Honest limits

- **8-bit, inter-frame-compressed video.** Only ~1 frame in 12 is intra-coded.
  The codec has already smoothed and correlated what it kept. Nothing downstream
  can undo that.
- **Realtime decode.** `requestVideoFrameCallback` runs at playback speed, so a
  45-second clip costs 45 seconds per pass just to read. It is not the
  bottleneck — the alignment work costs several times more — but it is a floor.
- **No colour.** The green plane only. A white-light solar disc carries no colour
  information worth the tripled transfer cost, but this rules out Ha or
  false-colour work without a change.
- **Full-disc assumption.** Registration starts from the centroid of everything
  above a fraction of peak brightness. A close-up of a sunspot group with no limb
  in frame has no disc to find, and would need a different coarse stage.
- **No wavelet sharpening.** Only an unsharp mask. The Registax-style wavelet
  decomposition is the natural next step and `pyrUp`/`pyrDown` are available.
- **No drizzle, no derotation, no calibration frames.**

---

## Non-goals

- Planetary imaging. Much of this would transfer, but Jupiter and Mars need a
  different coarse registration and this has not been tested on them.
- Anything requiring exposures shorter than the atmospheric coherence time —
  speckle reconstruction and the bispectrum methods used in professional solar
  physics. That information has to be captured; it cannot be recovered in post.
- Video export, timelapse, or animation.

---

## Inherited from the chassis

Worker respawn on OOM, the megapixel budget, `cv.exceptionFromPtr` decoding, Mat
lifecycle by hand, the inline pre-module error trap, the `?v=` cache buster, and
the discipline of keeping the algorithm in a `pipeline.js` that both the worker
and node can load — so the harness measures the shipped code.

Accumulators live in JavaScript typed arrays rather than `cv.Mat`, as in
AstroFuse, because the binding limit on this build is the wasm32 heap.

## Licence

AGPL-3.0, matching the rest of the family.
