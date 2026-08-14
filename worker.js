// SolFuse worker: OpenCV and the accumulators live here so the UI never blocks.
// The algorithm is in pipeline.js, which node also loads, so tools/bench-solar.js
// measures this exact code.
//
// Two passes over the video, because multi-point alignment needs a low-noise
// reference and the only way to get one is to stack first:
//
//   begin    { w, h, opts }              set up, allocate
//   frame    { gray, index, seq, phase } phase 1: global align + accumulate
//                                        phase 2: multi-point + accumulate
//   buildRef {}                          finish pass 1, cut alignment points
//   finish   { sharpen, ... }            render
//
// `index` is the frame's presentation time in milliseconds, not a counter: it is
// stable across the two decode passes even if the browser presents a slightly
// different set of frames each time, so pass 2 can look up the transform pass 1
// computed. `seq` is the within-pass counter, used only to split odd from even
// frames for the reliability measurement.
//
// Frames arrive as 8-bit grayscale, converted on the main thread while the
// video decodes. Sending RGBA would triple the transfer for no benefit — the
// disc through a white-light filter carries no colour information.

const V = self.location.search;
importScripts('vendor/opencv.js', 'pipeline.js' + V);

let cv = null, P = null, O = null;
let W = 0, H = 0;
let acc1 = null, acc2 = null;
let refQuarter = null, ref8 = null, aps = null, NG = 0;
let transforms = [];
let ramp = null, mapx = null, mapy = null, mapMatX = null, mapMatY = null;
let globMean = null, mpaMean = null;
let firstFrame = null;      // first aligned frame, kept for the before/after and the noise estimate
let stats = { ecc: 0, shifts: [], used: [], field: [] };
let quality = [];        // per-frame sharpness from pass 1, keyed by index
let rankOf = null;       // index -> its quality rank as a fraction in (0,1]
let curve = null;        // nested keep-fraction accumulators over a small ROI
let PREVIEW_EVERY = 20;

const post = (m, t) => self.postMessage(m, t || []);

function describe(err) {
  if (typeof err === 'number' && cv && cv.exceptionFromPtr) {
    try { return cv.exceptionFromPtr(err).msg; } catch { return 'wasm exception ' + err; }
  }
  return (err && err.message) || String(err);
}
const isOOM = (s) => /Insufficient memory|OutOfMemory|allocat|out of memory|Array buffer/i.test(s);

// The vendored build resolves cv through a thenable, not onRuntimeInitialized.
async function ready() {
  if (cv) return;
  cv = await Promise.resolve(self.cv);
  P = self.createPipeline(cv);
}

function freeAll() {
  if (refQuarter) { refQuarter.delete(); refQuarter = null; }
  if (ref8) { ref8.delete(); ref8 = null; }
  if (aps) { for (const a of aps) { if (a.tmpl) a.tmpl.delete(); } aps = null; }
  acc1 = acc2 = null; transforms = []; globMean = mpaMean = null;
  if (mapMatX) { mapMatX.delete(); mapMatX = null; }
  if (mapMatY) { mapMatY.delete(); mapMatY = null; }
  ramp = mapx = mapy = null; firstFrame = null;
  quality = []; rankOf = null; curve = null;
  stats = { ecc: 0, shifts: [], used: [], field: [] };
}

// Powers of two first, then a fixed cadence. The early frames are where the
// visible change is fastest — four frames already look markedly cleaner than
// one — and a fixed cadence alone means a short clip finishes without ever
// showing a preview, which is how this was first written.
const duePreview = (n) => (n <= 16 ? (n & (n - 1)) === 0 : n % PREVIEW_EVERY === 0);

// A running look at the stack as it builds. Watching the noise disappear is the
// clearest possible explanation of what stacking does, and it costs a strided
// downsample every PREVIEW_EVERY frames.
function sendPreview(acc, phase, grid) {
  const mean = new Float32Array(acc.sum.length);
  const k = 1 / Math.max(1, acc.frames);
  for (let i = 0; i < mean.length; i++) mean[i] = acc.sum[i] * k;
  const p = P.preview(mean, O.canvas, 420);
  const msg = { type: 'preview', rgba: p.rgba.buffer, size: p.size, phase, frames: acc.frames };
  const transfer = [p.rgba.buffer];
  if (grid) {
    // The displacement field, sent as the raw grid so the main thread can draw
    // it however it likes. 21x21 floats is under 4 kB.
    msg.grid = { n: NG, gx: grid.gx.buffer, gy: grid.gy.buffer };
    transfer.push(grid.gx.buffer, grid.gy.buffer);
  }
  post(msg, transfer);
}

const handlers = {
  async begin(m) {
    await ready();
    freeAll();
    W = m.w; H = m.h;
    O = Object.assign({}, P.DEFAULTS, m.opts || {});
    // step must divide canvas or the grid points stop landing on cell centres.
    O.canvas = Math.round(O.canvas / O.step) * O.step;
    acc1 = P.newAccumulator(O.canvas, true);
    post({ type: 'began', canvas: O.canvas });
  },

  async frame(m) {
    const gray = new Uint8Array(m.gray);
    if (m.phase === 1) {
      if (!refQuarter) {
        const c = P.discCentroid(gray, W, H, O.discFrac);
        if (!c) { post({ type: 'framed', index: m.index, skipped: true }); return; }
        const warp = P.warpToCanvas(gray, W, H,
          [1, 0, O.canvas / 2 - c.cx, 0, 1, O.canvas / 2 - c.cy], O.canvas);
        refQuarter = P.quarterNorm(warp, O.quarter);
        warp.delete();
      }
      const g = P.solveGlobal(gray, W, H, refQuarter, O);
      if (!g) { transforms[m.index] = null; post({ type: 'framed', index: m.index, skipped: true }); return; }
      if (!g.ecc) stats.ecc++;
      stats.shifts.push(g.shift);
      transforms[m.index] = g.C;
      const warped = P.warpToCanvas(gray, W, H, g.C, O.canvas);
      if (!firstFrame) firstFrame = Float32Array.from(warped.data);
      if (O.curve) quality[m.index] = P.frameQuality(warped, O.canvas, 700);
      const cover1 = P.coverageOf(g.C, W, H, O.canvas);
      P.accumulate(acc1, warped.data, cover1, m.seq);
      warped.delete();
      if (duePreview(acc1.frames)) sendPreview(acc1, 1, null);
      post({ type: 'framed', index: m.index, phase: 1,
             cx: g.centroid.cx, cy: g.centroid.cy, radius: g.centroid.radius,
             refine: g.shift, ecc: g.ecc });
    } else {
      const C = transforms[m.index];
      if (!C) { post({ type: 'framed', index: m.index, skipped: true }); return; }
      const warped = P.warpToCanvas(gray, W, H, C, O.canvas);
      const cover2 = P.coverageOf(C, W, H, O.canvas);
      let mag = null, used = null, grid = null;
      if (O.multipoint && aps && aps.length) {
        const f = P.measureField(warped, aps, NG, O);
        used = f.used;
        stats.used.push(f.used);
        const gx = P.fillNaN(f.gx, NG, O.taper), gy = P.fillNaN(f.gy, NG, O.taper);
        let sum = 0;
        for (let k = 0; k < gx.length; k++) sum += Math.hypot(gx[k], gy[k]);
        mag = sum / gx.length;
        stats.field.push(mag);
        grid = { gx: Float32Array.from(gx), gy: Float32Array.from(gy) };
        P.densify(gx, NG, O.canvas, ramp.X, mapx);
        P.densify(gy, NG, O.canvas, ramp.Y, mapy);
        mapMatX.data32F.set(mapx); mapMatY.data32F.set(mapy);
        const out = new cv.Mat();
        cv.remap(warped, out, mapMatX, mapMatY, cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar(0));
        P.accumulate(acc2, out.data, cover2, m.seq);
        if (curve && rankOf) P.accumulateCurve(curve, out, rankOf.get(m.index) ?? 1, m.seq);
        out.delete();
      } else {
        P.accumulate(acc2, warped.data, cover2, m.seq);
        if (curve && rankOf) P.accumulateCurve(curve, warped, rankOf.get(m.index) ?? 1, m.seq);
      }
      warped.delete();
      if (duePreview(acc2.frames)) sendPreview(acc2, 2, grid);
      post({ type: 'framed', index: m.index, phase: 2, field: mag, used });
    }
  },

  // End of pass 1: the stacked mean becomes the reference that alignment points
  // are cut from. Cutting them from a single frame instead would fold that
  // frame's noise into every displacement estimate.
  async buildRef() {
    globMean = P.finishAcc(acc1);
    const f = cv.matFromArray(O.canvas, O.canvas, cv.CV_32F, Array.from(globMean));
    ref8 = new cv.Mat();
    f.convertTo(ref8, cv.CV_8U);
    f.delete();
    if (O.multipoint) {
      const b = P.buildAPs(ref8, O);
      aps = b.aps; NG = b.NG;
      ramp = P.ramps(O.canvas);
      mapx = new Float32Array(O.canvas * O.canvas);
      mapy = new Float32Array(O.canvas * O.canvas);
      // Allocated once and refilled per frame; building them each time was the
      // single largest cost in the second pass.
      mapMatX = new cv.Mat(O.canvas, O.canvas, cv.CV_32F);
      mapMatY = new cv.Mat(O.canvas, O.canvas, cv.CV_32F);
      acc2 = P.newAccumulator(O.canvas, true);
    }
    // Rank the frames pass 1 graded, so pass 2 knows which keep-fractions each
    // frame belongs to. The ROI for the trade-off curve is centred on the
    // best-contrast alignment point: measuring reproducible detail over blank
    // photosphere would be measuring nothing.
    if (O.curve) {
      const graded = [];
      quality.forEach((q, i) => { if (q != null) graded.push([i, q]); });
      if (graded.length >= 8) {
        graded.sort((a, b) => b[1] - a[1]);              // sharpest first
        rankOf = new Map();
        graded.forEach(([i], k) => rankOf.set(i, (k + 1) / graded.length));
        let cx = O.canvas / 2, cy = O.canvas / 2;
        if (aps && aps.length) {
          const best = aps.reduce((p, a) => (a.contrast > p.contrast ? a : p), aps[0]);
          cx = best.x; cy = best.y;
        }
        curve = P.newCurve(Math.min(512, O.canvas), cx, cy);
      }
    }

    const sh = stats.shifts.slice().sort((a, b) => a - b);
    // Alignment-point positions go to the UI so the grid can be drawn over the
    // preview: it is the clearest way to show what "multi-point" means, and
    // which parts of the disc had enough structure to be locatable at all.
    post({ type: 'refReady', aps: aps ? aps.length : 0, grid: NG,
           apPositions: aps ? aps.map((a) => [a.x, a.y]) : [],
           canvas: O.canvas,
           frames: acc1.frames, eccFailures: stats.ecc,
           medianRefine: sh.length ? sh[sh.length >> 1] : null });
  },

  async finish(m) {
    const lin = O.multipoint && acc2 && acc2.frames ? P.finishAcc(acc2) : globMean;
    mpaMean = lin;
    const r = P.render(lin, O.canvas, { lo: m.lo, hi: m.hi, sharpen: m.sharpen,
                                        sharpenRadius: m.sharpenRadius });
    const used = stats.used;
    const field = stats.field.slice().sort((a, b) => a - b);
    const buf = r.rgba.buffer;
    // Same tone curve as the stack, so the wipe compares stacks and not stretches.
    const before = P.render(firstFrame || lin, O.canvas,
      { forceLo: r.lo, forceHi: r.hi, sharpen: 0 });
    const bbuf = before.rgba.buffer;
    post({ type: 'result', rgba: buf, beforeRgba: bbuf, size: O.canvas,
           frames: (acc2 && acc2.frames) || acc1.frames,
           aps: aps ? aps.length : 0,
           apsUsed: used.length ? used.reduce((a, b) => a + b, 0) / used.length : null,
           fieldMedian: field.length ? field[field.length >> 1] : null,
           eccFailures: stats.ecc,
           quality: measureQuality(lin),
           curve: curve ? P.curveResult(curve) : null,
           mem: memory() }, [buf, bbuf]);
  },

  // Re-render what is already stacked: no re-decode, no re-align.
  async rerender(m) {
    if (!mpaMean) { post({ type: 'error', message: 'Nothing stacked yet.' }); return; }
    const r = P.render(mpaMean, O.canvas, { lo: m.lo, hi: m.hi, sharpen: m.sharpen,
                                            sharpenRadius: m.sharpenRadius });
    const buf = r.rgba.buffer;
    post({ type: 'result', rgba: buf, size: O.canvas, frames: (acc2 && acc2.frames) || acc1.frames,
           aps: aps ? aps.length : 0, mem: memory() }, [buf]);
  },

  async free() { freeAll(); post({ type: 'freed' }); },
};

// What this run actually achieved, measured on the user's own frames rather
// than quoted from the README. Costs a few seconds at the end.
function measureQuality(finalLin) {
  try {
    const mask = P.innerMask(ref8, O, 121);
    const q = { };
    const g = P.reliability(acc1, O.canvas, mask, 1.4, 3.2);
    const mp = acc2 && acc2.frames ? P.reliability(acc2, O.canvas, mask, 1.4, 3.2) : null;
    if (g) q.globalSNR = g.snr, q.globalR = g.r;
    if (mp) q.multiSNR = mp.snr, q.multiR = mp.r;
    if (g && mp) { q.snrGain = mp.snr / g.snr; q.saturated = g.saturated || mp.saturated; }
    // The other end of the same problem: r near zero means the measured region
    // holds almost no fine detail, so the SNR figures describe the target, not
    // the alignment. Measured on an eclipse crescent, whose interior is blank
    // photosphere: fine r = 0.27 while coarse r = 0.96 and the stack was sharp.
    if (g && g.r < 0.5) q.starved = true;

    const active = mp ? acc2 : acc1;
    const sFull = P.stackNoise(active, mask);
    const s1 = firstFrame ? P.frameNoise(firstFrame, finalLin, mask) : null;
    if (sFull != null) q.stackNoise = sFull;
    if (s1 != null) q.frameNoise = s1;
    if (sFull && s1) q.noiseReduction = s1 / sFull;
    return q;
  } catch (e) {
    return { error: describe(e) };     // stats are a bonus; never fail the run for them
  }
}

// Reported from inside the worker: performance.memory on the main thread cannot
// see this heap, so measuring there would show a flat figure however large the
// accumulators grow.
function memory() {
  const px = O ? O.canvas * O.canvas : 0;
  const bytes = (acc1 ? px * 8 * 3 : 0) + (acc2 ? px * 8 * 3 : 0) + (mapx ? px * 4 * 2 : 0);
  return {
    accumulatorMB: +(bytes / 1048576).toFixed(1),
    workerHeapMB: self.performance && performance.memory
      ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
  };
}

self.onmessage = async (e) => {
  const h = handlers[e.data.type];
  if (!h) { post({ type: 'error', message: `Unknown message ${e.data.type}` }); return; }
  try {
    await h(e.data);
  } catch (err) {
    const message = describe(err);
    post({ type: 'error', message, oom: isOOM(message), during: e.data.type });
  }
};
