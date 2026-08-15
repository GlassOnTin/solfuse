// SolFuse worker: OpenCV and the accumulators live here so the UI never blocks.
// The algorithm is in pipeline.js, which node also loads, so tools/bench-solar.js
// measures this exact code.
//
// Two passes over the video, because multi-point alignment needs a low-noise
// reference and the only way to get one is to stack first:
//
//   begin    { w, h, opts }              set up, allocate
//   frame    { gray | planes, index, seq, phase }  phase 1: global align + accumulate
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
// Frames arrive as 8-bit grayscale, or as planar RGB in colour mode. The green
// plane is a zero-copy subarray of the planar buffer and is byte-identical to
// the grayscale a mono run would send, so alignment, the PSF, the trade-off
// curve and every statistic operate on exactly the same data either way.
// Colour is additive: red and blue ride along through the same transform and
// the same displacement field, and are composited at render time.
// Frames arrive as 8-bit grayscale, converted on the main thread while the
// video decodes, or as planar RGB when colour mode is on.
//
// Mono is still the default because the claim behind it turns out to be true
// for white-light footage, and now measured rather than assumed: on C0013 the
// three channels are bit-identical in 100% of lit pixels, so colour there costs
// three times the transfer for literally nothing. Totality is the opposite --
// C0092 averages R 182, G 123, B 80 and only 2% of pixels are neutral, because
// prominences are H-alpha red. The app measures which one it has and says so.

const V = self.location.search;
importScripts('vendor/opencv.js', 'pipeline.js' + V);

let cv = null, P = null, O = null;
let W = 0, H = 0;
let acc1 = null, acc2 = null, chroma = null, chromaOf = 0;
let refQuarter = null, ref8 = null, aps = null, NG = 0;
let transforms = [];
let ramp = null, mapx = null, mapy = null, mapMatX = null, mapMatY = null;
let globMean = null, mpaMean = null, psf = null, psfCircles = null, psfSupport = null;
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
  acc1 = acc2 = null; chroma = null; chromaOf = 0; transforms = []; globMean = mpaMean = null;
  if (mapMatX) { mapMatX.delete(); mapMatX = null; }
  if (mapMatY) { mapMatY.delete(); mapMatY = null; }
  ramp = mapx = mapy = null; firstFrame = null;
  quality = []; rankOf = null; curve = null; psf = null; psfCircles = null; psfSupport = null;
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

// One rung of the PSF ladder: find a limb at this threshold and sample it.
// Returns null rather than throwing, so the caller can try the next rung.
function tryPSF(g, rung) {
  const geom = P.discGeometry(g, O.canvas, O.canvas, rung.frac, 1);
  if (!geom) return null;
  const opts = { span: rung.span, minContrast: rung.minContrast, rippleFrac: rung.rippleFrac };

  const attempts = [];
  const sol = P.fitLimb(geom, { inside: true, iters: 3000 });
  if (sol) {
    // Anything off the solar arc may belong to a lunar limb.
    const rest = [];
    for (let i = 0; i < geom.edge.length; i += 2) {
      const dx = geom.edge[i] - sol.cx, dy = geom.edge[i + 1] - sol.cy;
      if (Math.abs(Math.hypot(dx, dy) - sol.r) > 4) rest.push(geom.edge[i], geom.edge[i + 1]);
    }
    if (rest.length > 600) {
      const lun = P.fitLimb(Object.assign({}, geom, { edge: rest }), { inside: false, iters: 4000 });
      // the Moon is the better knife edge: no atmosphere, no limb darkening
      if (lun && lun.inliers > 300) attempts.push({ source: 'lunar', circle: lun, sign: +1, sol });
    }
    attempts.push({ source: 'solar', circle: sol, sign: -1, sol });
  }
  // Totality: a corona ring around a dark Moon, where neither sense test can
  // separate the boundaries because both enclose the centroid.
  const inner = P.fitInnerLimb(geom, { iters: 4000 });
  if (inner) attempts.push({ source: 'lunar (totality)', circle: inner, sign: +1, sol: null });

  for (const a of attempts) {
    let prof = P.edgeProfile(g, O.canvas, O.canvas, a.circle, a.sign, opts);
    if (!prof) continue;
    let r = P.psfFromProfile(prof, {});
    if (!r) continue;
    // The sampling span has to be comfortably wider than the blur. If it is not,
    // the far end of the profile is still on the rising edge, the contrast is
    // underestimated and so is the width — an 18 px span measured an 18 px FWHM
    // that was really over 20. Re-measure once with room to spare.
    if (r.fwhm > opts.span * 0.6) {
      const wider = Object.assign({}, opts, { span: Math.min(60, Math.ceil(r.fwhm * 2)) });
      const p2 = P.edgeProfile(g, O.canvas, O.canvas, a.circle, a.sign, wider);
      const r2 = p2 && P.psfFromProfile(p2, {});
      if (r2) { prof = p2; r = r2; opts.span = wider.span; }
    }
    // Does the width settle? A real edge has a flat plateau beyond the blur, so
    // widening the span further should change nothing. The corona has no plateau
    // — it declines all the way out — so its "width" grows with whatever span
    // you choose (18.1, 21.4, 23.4, 24.3, 25.1 px at spans 18 to 50 on one
    // totality stack). When that happens the figure is an upper bound, and
    // saying so is worth more than quoting the last value confidently.
    let unstable = false;
    {
      const test = Object.assign({}, opts, { span: Math.min(70, Math.round(opts.span * 1.4)) });
      const p3 = P.edgeProfile(g, O.canvas, O.canvas, a.circle, a.sign, test);
      const r3 = p3 && P.psfFromProfile(p3, {});
      if (r3 && Math.abs(r3.fwhm - r.fwhm) / Math.max(1e-6, r.fwhm) > 0.15) unstable = true;
    }
    return Object.assign({ psf: r, rung: rung.tag, span: opts.span, unstable }, a);
  }
  return null;
}

function finishPSF(best) {
  const { psf: r, circle, sol, source, sign } = best;
  psf = r;
  // Regions the geometry says are dark: inside the Moon, outside the Sun.
  const regions = [];
  if (source.startsWith('lunar')) regions.push({ cx: circle.cx, cy: circle.cy, r: circle.r, mode: 'inside' });
  if (sol && source !== 'lunar (totality)') regions.push({ cx: sol.cx, cy: sol.cy, r: sol.r, mode: 'outside' });
  psfCircles = { circle, sol, source, sign };
  psfSupport = regions.length ? P.buildSupport(O.canvas, regions, 8) : null;
  const buf = Float32Array.from(r.psf).buffer;
  post({ type: 'psf', source, rung: best.rung, span: best.span, unstable: best.unstable, k: r.k, sigma: r.sigma, fwhm: r.fwhm,
         kurtosis: r.kurtosis, residual: r.residual, profiles: r.profiles,
         radius: circle.r, psf: buf }, [buf]);
}

// One place decides mono or colour, so finish and rerender cannot drift apart.
// Falls back to mono whenever colour was not captured, rather than failing.
// How much colour the footage actually carried. Through a white-light solar
// filter this comes back near zero, and the user is better told that than left
// to wonder why the result looks grey.
function colourReport(lin) {
  if (!chroma || !ref8) return null;
  try {
    const cnt = (chromaOf === 2 && acc2) ? acc2.cnt : acc1.cnt;
    const col = P.finishChroma(chroma, cnt);
    const mask = P.innerMask(ref8, O, 40);
    return P.colourStrength(lin, col.r, col.b, mask);
  } catch (e) { return null; }
}

function renderStack(shown, lin, m) {
  const opt = { lo: m.lo, hi: m.hi, sharpen: m.sharpen,
                sharpenRadius: m.sharpenRadius, wavelet: m.wavelet };
  if (!chroma) return P.render(shown, O.canvas, opt);
  const cnt = (chromaOf === 2 && acc2) ? acc2.cnt : acc1.cnt;
  const col = P.finishChroma(chroma, cnt);
  // Luminance is the fully processed green -- deconvolved, wavelet-sharpened,
  // stretched. Colour comes from the raw stacked channels, low-passed. Chroma
  // must not inherit the sharpening or it turns stacking noise into speckle.
  return P.renderColour(shown, col.r, col.b, O.canvas,
    Object.assign({}, opt, { saturation: m.saturation != null ? m.saturation : 1,
                             chromaBlur: m.chromaBlur != null ? m.chromaBlur : 3.0,
                             chromaG: lin }));
}

// Red and blue take the same route green took: same affine, and where
// multi-point is on, the same displacement field that is still loaded in
// mapMatX/mapMatY from this frame. Re-measuring the field per channel would be
// three times the cost and could disagree between channels, which is exactly
// how colour fringing gets manufactured.
function accumulateColour(planeR, planeB, C, useField, cover, pass) {
  if (!chroma) { chroma = P.newChroma(O.canvas); chromaOf = pass; }
  if (chromaOf !== pass) return;
  const out = [];
  for (const plane of [planeR, planeB]) {
    const w = P.warpToCanvas(plane, W, H, C, O.canvas);
    if (useField) {
      const rm = new cv.Mat();
      cv.remap(w, rm, mapMatX, mapMatY, cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar(0));
      w.delete();
      out.push(rm);
    } else {
      out.push(w);
    }
  }
  P.accumulateChroma(chroma, out[0].data, out[1].data, cover, null);
  out[0].delete(); out[1].delete();
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
    chroma = null; chromaOf = 0;
    post({ type: 'began', canvas: O.canvas });
  },

  async frame(m) {
    // Colour mode sends R, G and B planes back to back. Green is a view into
    // that buffer, not a copy.
    let gray, planeR = null, planeB = null;
    if (m.planes) {
      const all = new Uint8Array(m.planes);
      const n = W * H;
      planeR = all.subarray(0, n);
      gray = all.subarray(n, 2 * n);
      planeB = all.subarray(2 * n, 3 * n);
    } else {
      gray = new Uint8Array(m.gray);
    }
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
      // Only one pass produces the image the user keeps, so colour is
      // accumulated only there: pass 2 when multi-point is on, pass 1 otherwise.
      if (planeR && !O.multipoint) {
        accumulateColour(planeR, planeB, g.C, null, cover1, 1);
      }
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
        if (planeR) accumulateColour(planeR, planeB, C, true, cover2, 2);
      } else {
        P.accumulate(acc2, warped.data, cover2, m.seq);
        if (curve && rankOf) P.accumulateCurve(curve, warped, rankOf.get(m.index) ?? 1, m.seq);
        if (planeR) accumulateColour(planeR, planeB, C, false, cover2, 2);
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

  // The PSF is measured from a limb in the finished stack: a step edge of known
  // geometry, sampled around the whole arc. The lunar limb is preferred when an
  // eclipse provides one, because the Moon has no limb darkening and is
  // therefore a far better knife edge than the Sun's own edge.
  async measurePSF() {
    if (!mpaMean) { post({ type: 'error', message: 'Nothing stacked yet.' }); return; }
    const g = new Uint8Array(O.canvas * O.canvas);
    for (let i = 0; i < g.length; i++) g[i] = Math.max(0, Math.min(255, mpaMean[i]));
    // A ladder rather than one setting. A bright full disc, a crescent and the
    // corona at totality need different thresholds and different sampling spans
    // — 0.45 of peak with an 18 px span finds nothing on a corona, which is how
    // this reported "not clean enough" on a perfectly good stack.
    const ladder = [
      { frac: O.discFrac, span: 18, minContrast: 40, rippleFrac: 0.06, tag: 'disc' },
      { frac: 0.30, span: 26, minContrast: 25, rippleFrac: 0.10, tag: 'faint' },
      { frac: 0.15, span: 34, minContrast: 15, rippleFrac: 0.16, tag: 'corona' },
    ];
    let best = null;
    for (const rung of ladder) {
      const r = tryPSF(g, rung);
      if (r) { best = r; break; }
    }
    if (!best) {
      post({ type: 'psf', error: 'No limb could be measured, at any threshold.' });
      return;
    }
    finishPSF(best);
  },

  async finish(m) {
    const lin = O.multipoint && acc2 && acc2.frames ? P.finishAcc(acc2) : globMean;
    mpaMean = lin;
    const shown = deconvolved(lin, m);
    const r = renderStack(shown, lin, m);
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
           ringing: psfCircles ? (() => {
             try {
               const r0 = P.measureRinging(shown, O.canvas, psfCircles.circle, psfCircles.sign, {});
               return r0 ? { overshoot: r0.overshoot, sigma: r0.overshootSigma } : null;
             } catch (e) { return null; }
           })() : null,
           curve: curve ? P.curveResult(curve) : null,
           colour: colourReport(lin),
           mem: memory() }, [buf, bbuf]);
  },

  // Re-render what is already stacked: no re-decode, no re-align.
  async rerender(m) {
    if (!mpaMean) { post({ type: 'error', message: 'Nothing stacked yet.' }); return; }
    const shown = deconvolved(mpaMean, m);
    const r = renderStack(shown, mpaMean, m);
    const buf = r.rgba.buffer;
    post({ type: 'result', rgba: buf, size: O.canvas, frames: (acc2 && acc2.frames) || acc1.frames,
           aps: aps ? aps.length : 0, colour: colourReport(mpaMean), mem: memory() }, [buf]);
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
// Deconvolution runs before the stretch, like the wavelet stage, and only when
// a PSF has actually been measured — never with an assumed one.
function deconvolved(lin, m) {
  const iters = Math.round(m && m.deconv || 0);
  if (!iters || !psf) return lin;
  return P.richardsonLucy(lin, O.canvas, psf.psf, psf.k, iters, {
    satLevel: 254,                       // clipped pixels say "at least", not "exactly"
    support: psfSupport, darkLevel: 0,
    tv: (m && m.tv) || 0,
  });
}

function memory() {
  const px = O ? O.canvas * O.canvas : 0;
  // Chroma is two Float32 planes and no counts of its own: coverage is
  // identical across channels, so it borrows the green stack's.
  const bytes = (acc1 ? px * 8 * 3 : 0) + (acc2 ? px * 8 * 3 : 0) + (mapx ? px * 4 * 2 : 0)
              + (chroma ? px * 4 * 2 : 0);
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
