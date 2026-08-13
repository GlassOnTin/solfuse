// SolFuse pipeline — the algorithm, with no DOM and no worker API in it.
//
// Loaded two ways, as in AstroFuse:
//   worker.js  importScripts('pipeline.js')  -> self.createPipeline
//   node       require('./pipeline.js')      -> module.exports.createPipeline
//
// so tools/bench-solar.js measures the same code the browser runs.
//
// This is a port of a Python proof of concept that was measured against 1140
// frames of real 4K solar video before any of it was written for the browser.
// The numbers that justify each choice are in README.md; the short version:
// multi-point alignment is worth 1.34x SNR and +9.8% reproducible fine detail,
// and frame selection is worth about 1%.
//
// Only OpenCV calls verified present in the vendored build are used:
// warpAffine, findTransformECC, matchTemplate, minMaxLoc, remap, resize,
// GaussianBlur, erode.

(function (root) {
  'use strict';

  function createPipeline(cv) {

    const DEFAULTS = {
      canvas: 2100,       // output square, centred on the disc
      quarter: 0.25,      // scale at which ECC is estimated
      step: 100,          // alignment-point grid pitch; canvas/step must be integer
      half: 64,           // patch half-size
      search: 12,         // +/- px searched around the globally-aligned position
      minCorr: 0.3,       // reject an alignment point below this peak correlation
      discFrac: 0.45,     // disc threshold as a fraction of peak brightness
      channel: 'green',
      multipoint: true,
    };

    // ---- input -------------------------------------------------------------

    function toGray(rgba, w, h, mode) {
      const g = new Uint8Array(w * h);
      if (mode === 'luma') {
        for (let i = 0, p = 0; i < g.length; i++, p += 4) {
          g[i] = (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) | 0;
        }
      } else {
        for (let i = 0, p = 1; i < g.length; i++, p += 4) g[i] = rgba[p];
      }
      return g;
    }

    // ---- the disc ----------------------------------------------------------

    // Centroid of everything above a fraction of peak brightness. Averaging over
    // ~10^5 pixels makes this a far more stable estimate than any feature could
    // be, and it tracks exposure drift because the threshold is relative.
    function discCentroid(gray, w, h, frac) {
      let max = 0;
      for (let i = 0; i < gray.length; i++) if (gray[i] > max) max = gray[i];
      const thr = Math.max(30, max * (frac === undefined ? DEFAULTS.discFrac : frac));
      let n = 0, sx = 0, sy = 0;
      for (let y = 0, i = 0; y < h; y++) {
        for (let x = 0; x < w; x++, i++) {
          if (gray[i] > thr) { n++; sx += x; sy += y; }
        }
      }
      if (!n) return null;
      return { cx: sx / n, cy: sy / n, area: n, radius: Math.sqrt(n / Math.PI), peak: max };
    }

    const grayMat = (gray, w, h) => {
      const m = new cv.Mat(h, w, cv.CV_8U);
      m.data.set(gray);
      return m;
    };

    // Translation putting the disc centre at the canvas centre.
    const centreShift = (cx, cy, canvas) =>
      cv.matFromArray(2, 3, cv.CV_64F, [1, 0, canvas / 2 - cx, 0, 1, canvas / 2 - cy]);

    // ---- global alignment --------------------------------------------------

    // ECC is estimated on a quarter-scale copy: it is a single global transform,
    // so the extra precision from full resolution is not worth the time.
    function quarterNorm(mat, scale) {
      const small = new cv.Mat();
      cv.resize(mat, small, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);
      const f = new cv.Mat();
      small.convertTo(f, cv.CV_32F);
      small.delete();
      const mean = new cv.Mat(), sd = new cv.Mat();
      cv.meanStdDev(f, mean, sd);
      const mu = mean.doubleAt(0, 0), sig = sd.doubleAt(0, 0) || 1;
      mean.delete(); sd.delete();
      const out = new cv.Mat();
      f.convertTo(out, cv.CV_32F, 1 / sig, -mu / sig);
      f.delete();
      return out;
    }

    // Returns the 2x3 mapping SOURCE pixels onto the canvas, centroid shift
    // refined by ECC. ECC's warp maps template to input, so it is inverted
    // before composing — getting this backwards doubles the error instead of
    // removing it, and looks superficially plausible.
    function solveGlobal(gray, w, h, refQuarter, o) {
      const c = discCentroid(gray, w, h, o.discFrac);
      if (!c) return null;
      const src = grayMat(gray, w, h);
      const M = centreShift(c.cx, c.cy, o.canvas);
      const coarse = new cv.Mat();
      cv.warpAffine(src, coarse, M, new cv.Size(o.canvas, o.canvas), cv.INTER_LINEAR,
                    cv.BORDER_CONSTANT, new cv.Scalar(0));
      const q = quarterNorm(coarse, o.quarter);
      coarse.delete();

      const W = cv.Mat.eye(2, 3, cv.CV_32F);
      let ok = true;
      try {
        cv.findTransformECC(refQuarter, q, W, cv.MOTION_EUCLIDEAN,
          new cv.TermCriteria(cv.TermCriteria_EPS | cv.TermCriteria_COUNT, 60, 1e-5),
          new cv.Mat(), 5);
      } catch (e) {
        ok = false;                       // keep the centroid solution
      }
      q.delete();

      // Full-scale ECC refinement: rotation is scale-free, translation is not.
      const a = W.floatAt(0, 0), b = W.floatAt(0, 1), tx = W.floatAt(0, 2) / o.quarter;
      const d = W.floatAt(1, 0), e = W.floatAt(1, 1), ty = W.floatAt(1, 2) / o.quarter;
      W.delete();

      // C = inv(refinement) * centreShift
      const det = a * e - b * d;
      const ia = e / det, ib = -b / det, id = -d / det, ie = a / det;
      const itx = -(ia * tx + ib * ty), ity = -(id * tx + ie * ty);
      const m02 = M.doubleAt(0, 2), m12 = M.doubleAt(1, 2);
      M.delete();
      const C = [ia, ib, ia * m02 + ib * m12 + itx,
                 id, ie, id * m02 + ie * m12 + ity];
      src.delete();
      return { C, centroid: c, ecc: ok, shift: Math.hypot(tx, ty) };
    }

    function warpToCanvas(gray, w, h, C, canvas) {
      const src = grayMat(gray, w, h);
      const M = cv.matFromArray(2, 3, cv.CV_64F, C);
      const dst = new cv.Mat();
      cv.warpAffine(src, dst, M, new cv.Size(canvas, canvas), cv.INTER_LINEAR,
                    cv.BORDER_CONSTANT, new cv.Scalar(0));
      src.delete(); M.delete();
      return dst;
    }

    // ---- multi-point alignment ---------------------------------------------
    //
    // Global alignment leaves ~1.3 px of residual across the disc (2.0 px at
    // p95, measured). That is not a shift the whole frame shares — the
    // atmosphere moves different parts of the disc by different amounts — so no
    // single affine can remove it. Each patch is located independently and the
    // frame is warped by the resulting displacement field.

    // Alignment points on a grid, keeping only those with enough structure to be
    // locatable. A patch of featureless photosphere correlates equally well
    // everywhere; its "displacement" would be noise, and it is better to
    // interpolate that point from neighbours that can be measured.
    function buildAPs(refMat, o) {
      const NG = Math.round(o.canvas / o.step);
      const mask = discMaskMat(refMat, o);
      const inner = new cv.Mat();
      const k = cv.Mat.ones(61, 61, cv.CV_8U);
      cv.erode(mask, inner, k);
      k.delete(); mask.delete();

      const cand = [];
      for (let j = 0; j < NG; j++) {
        for (let i = 0; i < NG; i++) {
          const x = Math.round((i + 0.5) * o.step), y = Math.round((j + 0.5) * o.step);
          const m = o.half + o.search;
          if (x - m < 0 || y - m < 0 || x + m >= o.canvas || y + m >= o.canvas) continue;
          if (!inner.ucharPtr(y, x)[0]) continue;
          const rect = new cv.Rect(x - o.half, y - o.half, o.half * 2, o.half * 2);
          const patch = refMat.roi(rect);
          cand.push({ i, j, x, y, contrast: bandContrast(patch), rect });
          patch.delete();
        }
      }
      inner.delete();
      if (!cand.length) return { aps: [], NG };
      const sorted = cand.map((c) => c.contrast).sort((a, b) => a - b);
      const cut = sorted[Math.floor(sorted.length * 0.25)];
      const aps = cand.filter((c) => c.contrast > cut);
      // Templates are cut once and kept: re-extracting 180 of them per frame
      // dominates the cost otherwise.
      for (const a of aps) a.tmpl = refMat.roi(a.rect).clone();
      return { aps, NG };
    }

    function discMaskMat(mat, o) {
      const mm = cv.minMaxLoc(mat);
      const mask = new cv.Mat();
      cv.threshold(mat, mask, mm.maxVal * o.discFrac, 255, cv.THRESH_BINARY);
      const u8 = new cv.Mat();
      mask.convertTo(u8, cv.CV_8U);
      mask.delete();
      return u8;
    }

    function bandContrast(patch) {
      const f = new cv.Mat();
      patch.convertTo(f, cv.CV_32F);
      const a = new cv.Mat(), b = new cv.Mat();
      cv.GaussianBlur(f, a, new cv.Size(0, 0), 1.4);
      cv.GaussianBlur(f, b, new cv.Size(0, 0), 3.2);
      cv.subtract(a, b, a);
      const mean = new cv.Mat(), sd = new cv.Mat();
      cv.meanStdDev(a, mean, sd);
      const v = sd.doubleAt(0, 0);
      f.delete(); a.delete(); b.delete(); mean.delete(); sd.delete();
      return v;
    }

    // Parabolic interpolation about the correlation peak, which is what turns a
    // whole-pixel match into a sub-pixel one.
    function subpixel(data, cols, rows, px, py) {
      let dx = 0, dy = 0;
      const at = (x, y) => data[y * cols + x];
      if (px > 0 && px < cols - 1) {
        const l = at(px - 1, py), m = at(px, py), r = at(px + 1, py);
        const den = l - 2 * m + r;
        if (Math.abs(den) > 1e-9) dx = (0.5 * (l - r)) / den;
      }
      if (py > 0 && py < rows - 1) {
        const u = at(px, py - 1), m = at(px, py), d = at(px, py + 1);
        const den = u - 2 * m + d;
        if (Math.abs(den) > 1e-9) dy = (0.5 * (u - d)) / den;
      }
      return [dx, dy];
    }

    function measureField(warped, aps, NG, o) {
      const gx = new Float32Array(NG * NG).fill(NaN);
      const gy = new Float32Array(NG * NG).fill(NaN);
      const res = new cv.Mat();
      let used = 0;
      for (const a of aps) {
        const win = warped.roi(new cv.Rect(a.x - o.half - o.search, a.y - o.half - o.search,
                                           (o.half + o.search) * 2, (o.half + o.search) * 2));
        cv.matchTemplate(win, a.tmpl, res, cv.TM_CCOEFF_NORMED);
        const mm = cv.minMaxLoc(res);
        win.delete();
        if (mm.maxVal < o.minCorr) continue;
        const [sx, sy] = subpixel(res.data32F, res.cols, res.rows, mm.maxLoc.x, mm.maxLoc.y);
        const u = mm.maxLoc.x + sx - o.search, v = mm.maxLoc.y + sy - o.search;
        if (Math.abs(u) > o.search - 1 || Math.abs(v) > o.search - 1) continue;
        gx[a.j * NG + a.i] = u; gy[a.j * NG + a.i] = v; used++;
      }
      res.delete();
      return { gx, gy, used };
    }

    // Unmeasured points take the mean of their measured neighbours, spreading
    // inward until the grid is full.
    function fillNaN(g, NG) {
      const a = Float32Array.from(g);
      for (let pass = 0; pass < 60; pass++) {
        let bad = 0;
        const next = Float32Array.from(a);
        for (let j = 0; j < NG; j++) {
          for (let i = 0; i < NG; i++) {
            const k = j * NG + i;
            if (!Number.isNaN(a[k])) continue;
            let s = 0, n = 0;
            for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const x = i + di, y = j + dj;
              if (x < 0 || y < 0 || x >= NG || y >= NG) continue;
              const v = a[y * NG + x];
              if (!Number.isNaN(v)) { s += v; n++; }
            }
            if (n) next[k] = s / n; else bad++;
          }
        }
        a.set(next);
        if (!bad) break;
      }
      for (let i = 0; i < a.length; i++) if (Number.isNaN(a[i])) a[i] = 0;
      return a;
    }

    // Grid -> full-size displacement maps. Grid points sit at cell centres, so a
    // plain resize lands them in the right places provided canvas/step is an
    // integer — which is why `step` must divide `canvas`.
    function densify(grid, NG, canvas, ramp, out) {
      const small = cv.matFromArray(NG, NG, cv.CV_32F, Array.from(grid));
      const blur = new cv.Mat();
      cv.GaussianBlur(small, blur, new cv.Size(0, 0), 0.9);
      const big = new cv.Mat();
      cv.resize(blur, big, new cv.Size(canvas, canvas), 0, 0, cv.INTER_CUBIC);
      small.delete(); blur.delete();
      const d = big.data32F;
      for (let i = 0; i < out.length; i++) out[i] = ramp[i] + d[i];
      big.delete();
    }

    function ramps(canvas) {
      const X = new Float32Array(canvas * canvas), Y = new Float32Array(canvas * canvas);
      for (let y = 0, i = 0; y < canvas; y++) {
        for (let x = 0; x < canvas; x++, i++) { X[i] = x; Y[i] = y; }
      }
      return { X, Y };
    }

    // ---- accumulation ------------------------------------------------------
    //
    // JavaScript typed arrays, not cv.Mat, for the same reason as AstroFuse: the
    // binding limit on this build is the wasm32 heap, and keeping the
    // accumulators off it makes frame count cost nothing.

    function newAccumulator(canvas, halves) {
      const n = canvas * canvas;
      const a = { canvas, sum: new Float64Array(n), frames: 0 };
      if (halves) { a.odd = new Float64Array(n); a.even = new Float64Array(n); a.nOdd = 0; a.nEven = 0; }
      return a;
    }

    function accumulate(acc, data, index) {
      const s = acc.sum;
      for (let i = 0; i < s.length; i++) s[i] += data[i];
      acc.frames++;
      if (acc.odd) {
        const h = index % 2 ? acc.odd : acc.even;
        for (let i = 0; i < h.length; i++) h[i] += data[i];
        if (index % 2) acc.nOdd++; else acc.nEven++;
      }
    }

    const finishAcc = (acc) => {
      const out = new Float32Array(acc.sum.length);
      const k = 1 / Math.max(1, acc.frames);
      for (let i = 0; i < out.length; i++) out[i] = acc.sum[i] * k;
      return out;
    };

    // ---- display -----------------------------------------------------------

    // A percentile stretch, not the astro midtone transfer: the solar disc is a
    // near-uniform bright field and an autostretch built for a dark sky would
    // drive it to white.
    function render(lin, canvas, o) {
      const opt = Object.assign({ lo: 0.2, hi: 99.9, sharpen: 0, sharpenRadius: 2.4 }, o || {});
      const n = lin.length;
      const samp = new Float32Array(Math.ceil(n / 16));
      let j = 0;
      for (let i = 0; i < n; i += 16) samp[j++] = lin[i];
      const s = samp.subarray(0, j).slice().sort();
      const lo = s[Math.floor((opt.lo / 100) * (j - 1))];
      const hi = s[Math.floor((opt.hi / 100) * (j - 1))];
      const scale = 255 / Math.max(1e-6, hi - lo);

      let src = new Float32Array(n);
      for (let i = 0; i < n; i++) src[i] = Math.max(0, Math.min(255, (lin[i] - lo) * scale));

      if (opt.sharpen > 0) {
        const m = cv.matFromArray(canvas, canvas, cv.CV_32F, Array.from(src));
        const b = new cv.Mat();
        cv.GaussianBlur(m, b, new cv.Size(0, 0), opt.sharpenRadius);
        const out = new cv.Mat();
        cv.addWeighted(m, 1 + opt.sharpen, b, -opt.sharpen, 0, out);
        src = Float32Array.from(out.data32F);
        m.delete(); b.delete(); out.delete();
      }

      const rgba = new Uint8ClampedArray(n * 4);
      for (let i = 0, q = 0; i < n; i++, q += 4) {
        const v = Math.max(0, Math.min(255, src[i]));
        rgba[q] = rgba[q + 1] = rgba[q + 2] = v;
        rgba[q + 3] = 255;
      }
      return { rgba, lo, hi };
    }

    return {
      DEFAULTS, toGray, discCentroid, grayMat, centreShift, quarterNorm,
      solveGlobal, warpToCanvas, buildAPs, discMaskMat, measureField,
      fillNaN, densify, ramps, subpixel,
      newAccumulator, accumulate, finishAcc, render,
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createPipeline };
  else root.createPipeline = createPipeline;
})(typeof self !== 'undefined' ? self : globalThis);
