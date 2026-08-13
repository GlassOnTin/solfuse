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
let ramp = null, mapx = null, mapy = null;
let globMean = null, mpaMean = null;
let stats = { ecc: 0, shifts: [], used: [], field: [] };

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
  ramp = mapx = mapy = null;
  stats = { ecc: 0, shifts: [], used: [], field: [] };
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
      P.accumulate(acc1, warped.data, m.seq);
      warped.delete();
      post({ type: 'framed', index: m.index, radius: g.centroid.radius });
    } else {
      const C = transforms[m.index];
      if (!C) { post({ type: 'framed', index: m.index, skipped: true }); return; }
      const warped = P.warpToCanvas(gray, W, H, C, O.canvas);
      if (O.multipoint && aps && aps.length) {
        const f = P.measureField(warped, aps, NG, O);
        stats.used.push(f.used);
        const gx = P.fillNaN(f.gx, NG), gy = P.fillNaN(f.gy, NG);
        let mag = 0;
        for (let k = 0; k < gx.length; k++) mag += Math.hypot(gx[k], gy[k]);
        stats.field.push(mag / gx.length);
        P.densify(gx, NG, O.canvas, ramp.X, mapx);
        P.densify(gy, NG, O.canvas, ramp.Y, mapy);
        const mx = cv.matFromArray(O.canvas, O.canvas, cv.CV_32F, Array.from(mapx));
        const my = cv.matFromArray(O.canvas, O.canvas, cv.CV_32F, Array.from(mapy));
        const out = new cv.Mat();
        cv.remap(warped, out, mx, my, cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar(0));
        P.accumulate(acc2, out.data, m.seq);
        mx.delete(); my.delete(); out.delete();
      } else {
        P.accumulate(acc2, warped.data, m.seq);
      }
      warped.delete();
      post({ type: 'framed', index: m.index });
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
      acc2 = P.newAccumulator(O.canvas, true);
    }
    const sh = stats.shifts.slice().sort((a, b) => a - b);
    post({ type: 'refReady', aps: aps ? aps.length : 0, grid: NG,
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
    post({ type: 'result', rgba: buf, size: O.canvas,
           frames: (acc2 && acc2.frames) || acc1.frames,
           aps: aps ? aps.length : 0,
           apsUsed: used.length ? used.reduce((a, b) => a + b, 0) / used.length : null,
           fieldMedian: field.length ? field[field.length >> 1] : null,
           eccFailures: stats.ecc,
           mem: memory() }, [buf]);
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
