#!/usr/bin/env node
// Headless harness. Runs the same pipeline.js the browser runs, over real video
// frames piped from ffmpeg, and reports split-half reliability for global
// alignment against multi-point alignment.
//
// Split-half is the measurement that matters: odd and even frames are stacked
// separately, so structure that is real appears in both halves and noise does
// not. A single-stack "noise" estimate cannot tell fine solar detail from grain,
// and reported multi-point as slightly worse when it is materially better.
//
//   node tools/bench-solar.js <video> [--frames N] [--no-multipoint] [--write DIR]

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createPipeline } = require('../pipeline.js');

const args = process.argv.slice(2);
const SRC = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const LIMIT = Number(opt('--frames', 0)) || Infinity;
const WRITE = opt('--write', null);
const TAPER = opt('--taper', null);
const COARSE = opt('--coarse', null);
const MINAPS = opt('--minaps', null);
const SEEING = Number(opt('--seeing', 0));   // exponent on local quality; 0 disables
const CURVE = args.includes('--curve');      // selection trade-off A(f)

if (!SRC) { console.error('usage: bench-solar.js <video> [--frames N] [--write DIR]'); process.exit(1); }

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,nb_frames', '-of', 'csv=p=0', file]).toString().trim();
  const [w, h, n] = out.split(',');
  return { w: +w, h: +h, n: +n };
}

// Raw grayscale frames straight from ffmpeg: no PNG decode, no disk.
function frameReader(file, w, h) {
  const size = w * h;
  const ff = spawn('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  ff.stderr.on('data', (d) => process.stderr.write(d));
  let buf = Buffer.alloc(0), done = false, waiter = null;
  ff.stdout.on('data', (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    if (waiter && buf.length >= size) { const f = waiter; waiter = null; f(); }
    if (buf.length > size * 8) ff.stdout.pause();
  });
  ff.stdout.on('end', () => { done = true; if (waiter) { const f = waiter; waiter = null; f(); } });
  return {
    async next() {
      while (buf.length < size && !done) await new Promise((r) => { waiter = r; });
      if (buf.length < size) return null;
      const out = new Uint8Array(buf.subarray(0, size));
      buf = buf.subarray(size);
      if (ff.stdout.isPaused() && buf.length < size * 4) ff.stdout.resume();
      return out;
    },
    close() { try { ff.kill('SIGKILL'); } catch {} },
  };
}

(async () => {
  const cv = await Promise.resolve(require('../vendor/opencv.js'));
  const P = createPipeline(cv);
  const o = Object.assign({}, P.DEFAULTS);
  if (TAPER != null) o.taper = Number(TAPER);
  if (COARSE) o.coarse = COARSE;
  if (MINAPS != null) o.minAPs = Number(MINAPS);
  const { w, h, n } = probe(SRC);
  const N = Math.min(LIMIT, n || Infinity);
  console.log(`SolFuse harness — ${SRC}, ${w}x${h}, ${N} of ${n} frames, canvas ${o.canvas}, coarse ${o.coarse}\n`);

  // ---- pass 1: global alignment, and the reference it produces -------------
  let t0 = Date.now();
  const acc1 = P.newAccumulator(o.canvas, true);
  const transforms = [];
  let refQuarter = null, shifts = [], eccFail = 0, rHint = null;
  const NG0 = Math.round(o.canvas / o.step);
  const qual = new Array(N).fill(null);
  const frameQ = new Array(N).fill(null);
  const eccReasons = new Map();
  const r1 = frameReader(SRC, w, h);
  for (let i = 0; i < N; i++) {
    const gray = await r1.next();
    if (!gray) break;
    if (!refQuarter) {
      // First frame defines the canvas registration; everything else lands on it.
      // It MUST use the same coarse method as the frames, or every frame starts
      // an entire disc-width away from the reference and ECC cannot converge.
      const c = P.coarseCentre(gray, w, h, o, null);
      const warp = P.warpToCanvas(gray, w, h,
        [1, 0, o.canvas / 2 - c.cx, 0, 1, o.canvas / 2 - c.cy], o.canvas);
      refQuarter = P.quarterNorm(warp, o.quarter);
      warp.delete();
    }
    const g = P.solveGlobal(gray, w, h, refQuarter, o, rHint);
    if (g && g.centroid && g.centroid.method === 'limb' && rHint == null) rHint = g.centroid.radius;
    if (!g) { transforms.push(null); continue; }
    if (!g.ecc) { eccFail++; if (eccReasons.size < 4 && g.eccError) eccReasons.set(g.eccError, (eccReasons.get(g.eccError)||0)+1); }
    shifts.push(g.shift);
    transforms.push(g.C);
    const m = P.warpToCanvas(gray, w, h, g.C, o.canvas);
    P.accumulate(acc1, m.data, P.coverageOf(g.C, w, h, o.canvas), i);
    if (SEEING) qual[i] = P.cellQuality(m, o.canvas, NG0, o);
    if (CURVE) frameQ[i] = P.frameQuality(m, o.canvas, 700);
    m.delete();
    if ((i + 1) % 100 === 0) process.stdout.write(`\r  pass 1: ${i + 1} frames`);
  }
  r1.close();
  const globMean = P.finishAcc(acc1);
  shifts.sort((a, b) => a - b);
  console.log(`\r  pass 1: ${acc1.frames} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s, ` +
              `ECC failures ${eccFail}, median refinement ${shifts[shifts.length >> 1].toFixed(2)} px`);
  for (const [why, n] of eccReasons) console.log(`    ECC failed ${n}x: ${why}`);

  // ---- alignment points, cut from the low-noise reference ------------------
  const refMat = cv.matFromArray(o.canvas, o.canvas, cv.CV_32F, Array.from(globMean));
  const ref8 = new cv.Mat();
  refMat.convertTo(ref8, cv.CV_8U);
  const { aps, NG } = P.buildAPs(ref8, o);
  console.log(`  ${aps.length} alignment points on a ${NG}x${NG} grid`);

  // ---- pass 2: multi-point ------------------------------------------------
  t0 = Date.now();
  const acc2 = P.newAccumulator(o.canvas, true, !!SEEING);
  const { X, Y } = P.ramps(o.canvas);
  const mapx = new Float32Array(o.canvas * o.canvas);
  const mapy = new Float32Array(o.canvas * o.canvas);
  const mapMatX = new cv.Mat(o.canvas, o.canvas, cv.CV_32F);
  const mapMatY = new cv.Mat(o.canvas, o.canvas, cv.CV_32F);
  // Each cell is graded against the same cell in other frames, taking the 80th
  // percentile as "as good as this patch gets". Grading a cell against other
  // cells in its own frame would just rediscover that the disc centre has more
  // contrast than the limb.
  let qref = null, wSpread = null;
  if (SEEING) {
    qref = new Float32Array(NG0 * NG0);
    for (let c = 0; c < qref.length; c++) {
      const col = [];
      for (let i = 0; i < N; i++) if (qual[i] && qual[i][c] > 0) col.push(qual[i][c]);
      col.sort((a, b) => a - b);
      qref[c] = col.length ? col[Math.min(col.length - 1, Math.floor(col.length * 0.8))] : 0;
    }
    const graded = qref.filter(v => v > 0).length;
    console.log(`  seeing weighting on, exponent ${SEEING}, ${graded} of ${qref.length} cells graded`);
  }
  // Is there local seeing to exploit, or is the metric grading noise? Seeing
  // evolves over tens of milliseconds, so at 30-60 fps a real signal correlates
  // between adjacent frames. Metric noise does not. Splitting the variance into
  // a whole-frame part and a per-cell part then says whether the variation is
  // even local -- if it is all frame-global, per-cell weighting is just
  // whole-frame selection wearing a hat.
  if (SEEING) {
    const cells = [];
    for (let c = 0; c < NG0 * NG0; c++) {
      if (!(qref[c] > 0)) continue;
      const ser = [];
      for (let i = 0; i < N; i++) ser.push(qual[i] && qual[i][c] > 0 ? qual[i][c] : NaN);
      if (ser.filter(Number.isFinite).length < N * 0.8) continue;
      const mu = ser.filter(Number.isFinite).reduce((a, b) => a + b, 0) / ser.filter(Number.isFinite).length;
      cells.push(ser.map(v => (Number.isFinite(v) ? v / mu - 1 : NaN)));
    }
    // Lags 1-4, not just 1: a codec artefact repeats on the GOP period and would
    // show as a spike at lag 3, where white metric noise is flat at zero.
    const lags = [];
    for (let L = 1; L <= 4; L++) {
      let acc = 0, nl = 0;
      for (const ser of cells) {
        let sxy = 0, sxx = 0, syy = 0, n = 0;
        for (let i = 0; i + L < ser.length; i++) {
          const a = ser[i], b = ser[i + L];
          if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
          sxy += a * b; sxx += a * a; syy += b * b; n++;
        }
        if (n > 8 && sxx > 0 && syy > 0) { acc += sxy / Math.sqrt(sxx * syy); nl++; }
      }
      lags.push(nl ? acc / nl : NaN);
    }
    const lag1 = lags[0];
    let vTot = 0, nTot = 0;
    const frameMean = [];
    for (let i = 0; i < N; i++) {
      let s = 0, n = 0;
      for (const ser of cells) if (Number.isFinite(ser[i])) { s += ser[i]; n++; vTot += ser[i] * ser[i]; nTot++; }
      frameMean.push(n ? s / n : NaN);
    }
    const fm = frameMean.filter(Number.isFinite);
    const fmu = fm.reduce((a, b) => a + b, 0) / fm.length;
    const vGlob = fm.reduce((a, b) => a + (b - fmu) * (b - fmu), 0) / fm.length;
    vTot /= Math.max(1, nTot);
    console.log(`    quality signal: lag-1 correlation ${lag1.toFixed(3)}` +
                ` (0 = the metric is grading noise), lags 2-4 ` +
                lags.slice(1).map(v => v.toFixed(3)).join('/') + ', ' +
                `${(100 * vGlob / vTot).toFixed(0)}% of variance is whole-frame, ` +
                `${(100 * (1 - vGlob / vTot)).toFixed(0)}% local`);
  }

  // Rank frames sharpest first, exactly as the worker does, so the harness
  // measures the same selection the app would make.
  let rankOf = null, curve = null;
  if (CURVE) {
    const graded = [];
    frameQ.forEach((q, i) => { if (q != null) graded.push([i, q]); });
    if (graded.length >= 8) {
      graded.sort((a, b) => b[1] - a[1]);
      rankOf = new Map();
      graded.forEach(([i], k) => rankOf.set(i, (k + 1) / graded.length));
      let cx = o.canvas / 2, cy = o.canvas / 2;
      if (aps && aps.length) {
        const best = aps.reduce((p, a) => (a.contrast > p.contrast ? a : p), aps[0]);
        cx = best.x; cy = best.y;
      }
      curve = P.newCurve(Math.min(512, o.canvas), cx, cy);
      const qs = graded.map(([, q]) => q);
      console.log(`  sharpness ranking over ${graded.length} frames, ` +
                  `best ${qs[0].toFixed(4)} worst ${qs[qs.length - 1].toFixed(4)} ` +
                  `(spread ${(100 * (qs[0] / qs[qs.length - 1] - 1)).toFixed(1)}%)`);
    }
  }

  const wmap = SEEING ? new Float32Array(o.canvas * o.canvas) : null;
  let usedTotal = 0, fieldMag = [], wStats = [];
  const r2 = frameReader(SRC, w, h);
  for (let i = 0; i < N; i++) {
    const gray = await r2.next();
    if (!gray || !transforms[i]) break;
    const warped = P.warpToCanvas(gray, w, h, transforms[i], o.canvas);
    const f = P.measureField(warped, aps, NG, o);
    usedTotal += f.used;
    const gx = P.fillNaN(f.gx, NG, o.taper), gy = P.fillNaN(f.gy, NG, o.taper);
    let mag = 0;
    for (let k = 0; k < gx.length; k++) mag += Math.hypot(gx[k], gy[k]);
    fieldMag.push(mag / gx.length);
    P.densify(gx, NG, o.canvas, X, mapx);
    P.densify(gy, NG, o.canvas, Y, mapy);
    mapMatX.data32F.set(mapx); mapMatY.data32F.set(mapy);
    const out = new cv.Mat();
    cv.remap(warped, out, mapMatX, mapMatY, cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar(0));
    if (SEEING && qual[i]) {
      const wc = P.cellWeights(qual[i], qref, NG0, SEEING);
      P.densifyWeights(wc, NG0, o.canvas, wmap);
      let sw = 0, nw = 0;
      for (let c = 0; c < wc.length; c++) if (wc[c] > 0) { sw += wc[c]; nw++; }
      if (nw) wStats.push(sw / nw);
    }
    P.accumulate(acc2, out.data, P.coverageOf(transforms[i], w, h, o.canvas), i, wmap);
    if (curve && rankOf && rankOf.has(i)) P.accumulateCurve(curve, out, rankOf.get(i), i);
    warped.delete(); out.delete();
    if ((i + 1) % 100 === 0) process.stdout.write(`\r  pass 2: ${i + 1} frames`);
  }
  r2.close();
  const mpaMean = P.finishAcc(acc2);
  fieldMag.sort((a, b) => a - b);
  console.log(`\r  pass 2: ${acc2.frames} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s, ` +
              `${(usedTotal / Math.max(1, acc2.frames)).toFixed(0)} of ${aps.length} points used per frame, ` +
              `field ${fieldMag[fieldMag.length >> 1].toFixed(2)} px median`);
  if (wStats.length) {
    const ws = wStats.slice().sort((a, b) => a - b);
    console.log(`    frame weight: median ${ws[ws.length >> 1].toFixed(3)}, ` +
                `range ${ws[0].toFixed(3)} to ${ws[ws.length - 1].toFixed(3)}, ` +
                `effective frames ${(wStats.reduce((a, b) => a + b, 0)).toFixed(1)} of ${acc2.frames}`);
  }

  if (curve) {
    const r = P.curveResult(curve);
    if (r && r.points && r.points.length) {
      console.log('\n  selection trade-off A(f) = sqrt(r_f) * rms_fine, over the sharpest f of frames');
      console.log('    keep    frames        r      rms      A');
      for (const pt of r.points) {
        console.log(`    ${(100 * pt.fraction).toFixed(0).padStart(4)}%  ${String(pt.frames).padStart(6)}  ` +
                    `${pt.r != null ? pt.r.toFixed(5).padStart(8) : '       -'}  ` +
                    `${pt.rms != null ? pt.rms.toFixed(3).padStart(7) : '      -'}  ` +
                    `${pt.amplitude != null ? pt.amplitude.toFixed(3).padStart(6) : '     -'}`);
      }
      console.log(`    best at ${(100 * r.bestFraction).toFixed(0)}% (${r.bestFrames} frames), ` +
                  `gain over using everything ${r.gainOverAll != null ? r.gainOverAll.toFixed(3) + 'x' : 'n/a'}`);
    }
  }

  // ---- split-half reliability ---------------------------------------------
  // Divide by the per-pixel weight sum, never by the frame count. Under seeing
  // weighting the two differ by the mean weight, which scales the whole half
  // image down and drags rms -- and so A -- with it. That looked exactly like
  // weighting destroying detail. Correlation is scale-invariant and showed
  // nothing, which is why it survived a first reading.
  const half = (acc, which) => {
    const src = which === 'odd' ? acc.odd : acc.even;
    const cnt = which === 'odd' ? acc.cntOdd : acc.cntEven;
    const out = new Float32Array(src.length);
    for (let i = 0; i < out.length; i++) out[i] = cnt[i] > 0 ? src[i] / cnt[i] : 0;
    return out;
  };
  const mask = P.discMaskMat(ref8, o);
  const inner = new cv.Mat();
  const k61 = cv.Mat.ones(121, 121, cv.CV_8U);
  cv.erode(mask, inner, k61);
  const im = inner.data;
  k61.delete(); mask.delete();

  const bandOf = (arr, s1, s2) => {
    const m = cv.matFromArray(o.canvas, o.canvas, cv.CV_32F, Array.from(arr));
    const a = new cv.Mat(), b = new cv.Mat();
    cv.GaussianBlur(m, a, new cv.Size(0, 0), s1);
    cv.GaussianBlur(m, b, new cv.Size(0, 0), s2);
    cv.subtract(a, b, a);
    const out = Float32Array.from(a.data32F);
    m.delete(); a.delete(); b.delete();
    return out;
  };
  const corr = (a, b) => {
    let n = 0, sa = 0, sb = 0;
    for (let i = 0; i < a.length; i++) if (im[i]) { n++; sa += a[i]; sb += b[i]; }
    const ma = sa / n, mb = sb / n;
    let ca = 0, cb = 0, cab = 0;
    for (let i = 0; i < a.length; i++) {
      if (!im[i]) continue;
      const da = a[i] - ma, db = b[i] - mb;
      ca += da * da; cb += db * db; cab += da * db;
    }
    return cab / Math.sqrt(ca * cb);
  };

  console.log('\nsplit-half reliability (odd vs even frame stacks)');
  console.log('  band            global r   multi-pt r   global SNR   mult SNR    SNR gain');
  const bands = [['fine 1.4-3.2', 1.4, 3.2], ['mid 3-7', 3, 7], ['coarse 7-15', 7, 15]];
  for (const [nm, s1, s2] of bands) {
    const rg = corr(bandOf(half(acc1, 'odd'), s1, s2), bandOf(half(acc1, 'even'), s1, s2));
    const rm = corr(bandOf(half(acc2, 'odd'), s1, s2), bandOf(half(acc2, 'even'), s1, s2));
    const sg = rg / (1 - rg), sm = rm / (1 - rm);
    // Flag saturation rather than printing a confident ratio built on 1e-4.
    const sat = Math.max(rg, rm) > 0.995 ? '  (r saturated — not evidence)' : '';
    console.log(`  ${nm.padEnd(15)} ${rg.toFixed(4).padStart(8)} ${rm.toFixed(4).padStart(12)} ` +
                `${sg.toFixed(1).padStart(12)} ${sm.toFixed(1).padStart(10)} ${(sm / sg).toFixed(3).padStart(11)}x${sat}`);
  }

  if (WRITE) {
    const { writePNG } = require('./png.js');
    fs.mkdirSync(WRITE, { recursive: true });
    for (const [nm, arr] of [['global', globMean], ['multipoint', mpaMean]]) {
      const r = P.render(arr, o.canvas, { sharpen: 0 });
      fs.writeFileSync(path.join(WRITE, `${nm}.png`), writePNG(r.rgba, o.canvas, o.canvas));
    }
    console.log(`\nwrote ${WRITE}/{global,multipoint}.png`);
  }
  refMat.delete(); ref8.delete(); inner.delete();
})().catch((e) => { console.error('harness failed:', e); process.exit(1); });
