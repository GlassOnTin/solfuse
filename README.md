# SolFuse — stack solar video in your browser

**Try it: <https://glassontin.github.io/solfuse/>**

Open a clip of the sun shot through a solar filter. The tool returns one stacked image. It averages out sensor noise and partially corrects atmospheric distortion. Everything runs on your device. There is no upload and no backend.

[VISION.md](VISION.md) explains the design. [MEASUREMENTS.md](MEASUREMENTS.md) records all measurements. This includes measurements that proved earlier claims in this file wrong.

## How it works

```
video -> requestVideoFrameCallback -> green plane
  pass 1:  disc centroid -> ECC refine (quarter scale) -> warp -> accumulate
  pass 2:  warp with cached transform -> ~180 alignment points
           -> matchTemplate + parabolic sub-pixel -> displacement field
           -> remap -> accumulate
  render:  percentile stretch, wavelet sharpening, optional deconvolution
```

While it runs, you watch the stack build. The measured distortion field is drawn over it. You see a timeline of per-frame distortion and a before/after wipe. The stats panel reports what the run achieved on *your* footage. It leaves out anything it cannot compute rather than guessing.

## Results, in brief

All figures below were measured on real 4K solar video (1140 frames, 25 fps, disc ~1870 px across). Methods, tables and caveats are in [MEASUREMENTS.md](MEASUREMENTS.md).

- Stacking cuts high-frequency noise to 0.106× of a single frame.
- Multi-point alignment gains 1.34× fine-band SNR over global alignment and raises reproducible fine-detail amplitude 9.8%. This feature earns its keep.
- Lucky-imaging frame selection was tested against a random control and buys about 1% on this footage. At a 63 mm effective aperture, the frames are already near diffraction-limited. There is little sharpness variation to select between. Stacking everything wins.
- The point spread function is measured from the limb rather than assumed. Richardson–Lucy deconvolution genuinely recovers detail at 2 iterations (1.85× lower error against ground truth) and diverges beyond about 4. It ships off by default with a capped range.
- Colour is off by default because the app measures whether the footage has any. The white-light test clip is bit-identical across all three channels, while totality footage is strongly coloured. The app tells you which you have.

## Running it

```sh
python3 -m http.server 8413        # then open http://localhost:8413/
```

Headless, against any video ffmpeg can read:

```sh
node tools/bench-solar.js /path/to/clip.MP4 --frames 200 --write testdata/out
```

The harness reports split-half reliability for global versus multi-point alignment. This metric shows if the second pass is worth keeping. Run `node tools/test-pipeline.js` for unit tests (46 tests, no dependencies).

Run `tools/bump-cache.sh` before deploying. Pages serves `max-age=600`.

## Repository layout

| | |
|---|---|
| `index.html` | markup, CSS, inline pre-module error trap |
| `app.js` | video frame extraction, drives the two passes, export |
| `worker.js` | OpenCV, accumulators, message protocol |
| `pipeline.js` | the algorithm — loaded by both the worker and node |
| `tools/bench-solar.js` | headless harness, split-half reliability |
| `tools/test-pipeline.js` | unit tests against analytic ground truth |
| `vendor/` | OpenCV.js (`@techstark/opencv-js` 5.0.0), pinned by hash |

## Not tested

- The in-browser video decode path. The automation browser used for testing cannot decode video. Everything downstream was verified on real frames fed as images.
- Phones, Firefox, Safari.
- One camera, one filter, one day's seeing. Planetary targets — the coarse stage assumes a disc with a limb.
- The 2800 px output option. Every figure above uses 2100 px.

## Licence

AGPL-3.0.
