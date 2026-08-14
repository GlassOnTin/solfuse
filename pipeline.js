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
      taper: 2.5,      // grid steps the correction survives past the last measurement; 0 disables
      // 'centroid' | 'limb'. The limb fit is the geometrically correct answer
      // for an occluded or clipped disc — on a partial eclipse the centroid sits
      // 430 px from the true centre — and the fit itself is validated and fast
      // (18-28 ms/frame). But driving the whole pipeline from it currently runs
      // pathologically slowly for reasons not yet understood, so it is not the
      // default and should be treated as unproven.
      coarse: 'centroid',
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

    // Boundary of the lit region, plus the centroid, in one pass. Boundary
    // points that sit on the frame border are dropped: those are where the
    // sensor cut the image, not where the Sun ends.
    function discGeometry(gray, w, h, frac, stride) {
      let max = 0;
      for (let i = 0; i < gray.length; i++) if (gray[i] > max) max = gray[i];
      const thr = Math.max(30, max * (frac === undefined ? DEFAULTS.discFrac : frac));
      const lit = new Uint8Array(gray.length);
      let n = 0, sx = 0, sy = 0;
      for (let y = 0, i = 0; y < h; y++) {
        for (let x = 0; x < w; x++, i++) {
          if (gray[i] > thr) { lit[i] = 1; n++; sx += x; sy += y; }
        }
      }
      if (!n) return null;
      const st = stride || 3;
      const edge = [];
      let clipped = 0;
      for (let y = 1; y < h - 1; y += st) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!lit[i]) continue;
          if (lit[i - 1] && lit[i + 1] && lit[i - w] && lit[i + w]) continue;
          if (x < 3 || y < 3 || x > w - 4 || y > h - 4) { clipped++; continue; }
          edge.push(x, y);
        }
      }
      return { cx: sx / n, cy: sy / n, area: n, radius: Math.sqrt(n / Math.PI),
               peak: max, edge, clipped };
    }

    // ---- solar limb fit ----------------------------------------------------
    //
    // The centroid of a lit region is only the disc centre when the disc is
    // whole. Eclipsed, or cut by the frame edge, it is not — and it migrates as
    // the Moon advances. The solar limb, by contrast, is a circle of fixed
    // radius whatever is in front of it, so fitting that circle recovers the
    // true centre from any visible arc.
    //
    // The catch during an eclipse is that the lunar limb is an arc of very
    // similar radius. It is told apart geometrically: the lit region lies
    // INSIDE the solar circle and OUTSIDE the lunar one.

    // Circle through three points. Returns null if they are near-collinear.
    function circumcircle(x1, y1, x2, y2, x3, y3) {
      const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
      if (Math.abs(d) < 1e-6) return null;
      const s1 = x1 * x1 + y1 * y1, s2 = x2 * x2 + y2 * y2, s3 = x3 * x3 + y3 * y3;
      const cx = (s1 * (y2 - y3) + s2 * (y3 - y1) + s3 * (y1 - y2)) / d;
      const cy = (s1 * (x3 - x2) + s2 * (x1 - x3) + s3 * (x2 - x1)) / d;
      return { cx, cy, r: Math.hypot(x1 - cx, y1 - cy) };
    }

    // Kasa algebraic fit: minimise sum (x^2 + y^2 + Dx + Ey + F)^2, linear in
    // D, E, F, so it is a 3x3 solve rather than an iteration.
    function fitCircleLS(pts, idx) {
      let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sz = 0, Sxz = 0, Syz = 0;
      const n = idx.length;
      if (n < 3) return null;
      for (const k of idx) {
        const x = pts[2 * k], y = pts[2 * k + 1], z = x * x + y * y;
        Sx += x; Sy += y; Sxx += x * x; Syy += y * y; Sxy += x * y;
        Sz += z; Sxz += x * z; Syz += y * z;
      }
      const a = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]];
      const b = [-Sxz, -Syz, -Sz];
      for (let i = 0; i < 3; i++) {                    // Gaussian elimination
        let p = i;
        for (let j = i + 1; j < 3; j++) if (Math.abs(a[j][i]) > Math.abs(a[p][i])) p = j;
        if (Math.abs(a[p][i]) < 1e-12) return null;
        [a[i], a[p]] = [a[p], a[i]]; [b[i], b[p]] = [b[p], b[i]];
        for (let j = i + 1; j < 3; j++) {
          const f = a[j][i] / a[i][i];
          for (let k = i; k < 3; k++) a[j][k] -= f * a[i][k];
          b[j] -= f * b[i];
        }
      }
      const sol = [0, 0, 0];
      for (let i = 2; i >= 0; i--) {
        let t = b[i];
        for (let k = i + 1; k < 3; k++) t -= a[i][k] * sol[k];
        sol[i] = t / a[i][i];
      }
      const cx = -sol[0] / 2, cy = -sol[1] / 2;
      const rr = cx * cx + cy * cy - sol[2];
      if (!(rr > 0)) return null;
      return { cx, cy, r: Math.sqrt(rr) };
    }

    // Deterministic PRNG so a rerun gives the same fit.
    function lcg(seed) {
      let s = seed >>> 0;
      return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    }

    function fitLimb(geom, o) {
      const opt = Object.assign({ tol: 2.5, iters: 400, minInliers: 0.15, rHint: null, rTol: 0.25 }, o || {});
      const pts = geom.edge, n = pts.length / 2;
      if (n < 30) return null;
      const rnd = lcg(0x5f3759df ^ n);
      let best = null;
      for (let it = 0; it < opt.iters; it++) {
        const i = (rnd() * n) | 0, j = (rnd() * n) | 0, k = (rnd() * n) | 0;
        if (i === j || j === k || i === k) continue;
        const c = circumcircle(pts[2*i], pts[2*i+1], pts[2*j], pts[2*j+1], pts[2*k], pts[2*k+1]);
        if (!c) continue;
        if (opt.rHint && Math.abs(c.r - opt.rHint) > opt.rTol * opt.rHint) continue;
        // The lit region must lie inside a solar limb. This is what separates it
        // from the lunar limb, which has a similar radius but the opposite sense.
        if (Math.hypot(geom.cx - c.cx, geom.cy - c.cy) > c.r) continue;
        let inl = 0;
        for (let p = 0; p < n; p++) {
          const dx = pts[2*p] - c.cx, dy = pts[2*p+1] - c.cy;
          if (Math.abs(Math.hypot(dx, dy) - c.r) < opt.tol) inl++;
        }
        if (!best || inl > best.inl) best = { c, inl };
      }
      if (!best || best.inl < opt.minInliers * n) return null;
      const idx = [];
      for (let p = 0; p < n; p++) {
        const dx = pts[2*p] - best.c.cx, dy = pts[2*p+1] - best.c.cy;
        if (Math.abs(Math.hypot(dx, dy) - best.c.r) < opt.tol) idx.push(p);
      }
      const ref = fitCircleLS(pts, idx) || best.c;
      return { cx: ref.cx, cy: ref.cy, r: ref.r, inliers: idx.length, points: n,
               fraction: idx.length / n };
    }

    // The source Mat is 8.3 MB at 4K and was allocated and freed once per frame
    // per pass. It is reused instead. Callers must NOT delete it.
    let srcCache = null;
    const grayMat = (gray, w, h) => {
      if (!srcCache || srcCache.rows !== h || srcCache.cols !== w) {
        if (srcCache) srcCache.delete();
        srcCache = new cv.Mat(h, w, cv.CV_8U);
      }
      srcCache.data.set(gray);
      return srcCache;
    };
    const releaseScratch = () => { if (srcCache) { srcCache.delete(); srcCache = null; } };

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
    // The coarse centre. A centroid is excellent on a whole disc and wrong on a
    // crescent — measured 430 px from the true centre on a partial eclipse —
    // where the limb circle is right by construction. Neither is universally
    // better, so which one is used is a decision, not a constant.
    function coarseCentre(gray, w, h, o, rHint) {
      if (o.coarse === 'limb') {
        const geom = discGeometry(gray, w, h, o.discFrac, o.edgeStride || 3);
        if (!geom) return null;
        const L = fitLimb(geom, { rHint });
        if (L) return { cx: L.cx, cy: L.cy, radius: L.r, area: geom.area,
                        method: 'limb', inlierFraction: L.fraction };
        // Fall back rather than fail: a limb fit needs a visible arc.
        return { cx: geom.cx, cy: geom.cy, radius: geom.radius, area: geom.area,
                 method: 'centroid-fallback' };
      }
      const c = discCentroid(gray, w, h, o.discFrac);
      if (!c) return null;
      c.method = 'centroid';
      return c;
    }

    function solveGlobal(gray, w, h, refQuarter, o, rHint) {
      const c = coarseCentre(gray, w, h, o, rHint);
      if (!c) return null;
      const src = grayMat(gray, w, h);
      const M = centreShift(c.cx, c.cy, o.canvas);
      const coarse = new cv.Mat();
      cv.warpAffine(src, coarse, M, new cv.Size(o.canvas, o.canvas), cv.INTER_LINEAR,
                    cv.BORDER_CONSTANT, new cv.Scalar(0));
      const q = quarterNorm(coarse, o.quarter);
      coarse.delete();

      const W = cv.Mat.eye(2, 3, cv.CV_32F);
      let ok = true, eccError = null;
      try {
        cv.findTransformECC(refQuarter, q, W, cv.MOTION_EUCLIDEAN,
          new cv.TermCriteria(cv.TermCriteria_EPS | cv.TermCriteria_COUNT, 60, 1e-5),
          new cv.Mat(), 5);
      } catch (e) {
        // Keep the coarse solution, but record WHY. Swallowing this made an ECC
        // failure indistinguishable from a successful zero correction, and cost
        // a long debugging session on the limb path.
        ok = false;
        eccError = (typeof e === 'number' && cv.exceptionFromPtr)
          ? (() => { try { return cv.exceptionFromPtr(e).msg; } catch { return 'wasm ' + e; } })()
          : ((e && e.message) || String(e));
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
      return { C, centroid: c, ecc: ok, eccError, shift: Math.hypot(tx, ty) };
    }

    // Which canvas pixels this frame actually supplied data for.
    //
    // warpAffine fills everything outside the source with zeros, and summing
    // those as though they were measurements darkens whatever the frame did not
    // cover. On a clip that drifts — 580 px over 27 s was measured — the edges
    // are progressively biased toward black by frames that never saw them.
    //
    // Computed by inverting the affine and testing bounds, which is exact for an
    // affine map and cheaper than warping a second mask. The increment along a
    // row is constant, so it is two adds per pixel.
    function coverageOf(C, w, h, canvas) {
      const det = C[0] * C[4] - C[1] * C[3];
      if (!det) return null;
      const ia = C[4] / det, ib = -C[1] / det, id = -C[3] / det, ie = C[0] / det;
      const itx = -(ia * C[2] + ib * C[5]), ity = -(id * C[2] + ie * C[5]);
      const cov = new Uint8Array(canvas * canvas);
      const xmax = w - 1.001, ymax = h - 1.001;
      for (let y = 0, i = 0; y < canvas; y++) {
        let sx = ib * y + itx, sy = ie * y + ity;
        for (let x = 0; x < canvas; x++, i++, sx += ia, sy += id) {
          cov[i] = (sx >= 0 && sy >= 0 && sx <= xmax && sy <= ymax) ? 1 : 0;
        }
      }
      return cov;
    }

    function warpToCanvas(gray, w, h, C, canvas) {
      const src = grayMat(gray, w, h);        // shared scratch, not ours to free
      const M = cv.matFromArray(2, 3, cv.CV_64F, C);
      const dst = new cv.Mat();
      cv.warpAffine(src, dst, M, new cv.Size(canvas, canvas), cv.INTER_LINEAR,
                    cv.BORDER_CONSTANT, new cv.Scalar(0));
      M.delete();
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
    // outward — but fading to zero as they go.
    //
    // Only about 40% of grid cells sit on a locatable alignment point; the rest
    // are outside the disc or over featureless photosphere. Propagating the
    // nearest measurement into them without decay invents motion where none was
    // observed: measured cells carry a median 0.32 px displacement while the
    // filled ones carried 0.74 px, and those inflated values warp the outer
    // canvas. That cost the coarse band more than multi-point alignment gained
    // it, turning a 1.49x improvement into 0.94x.
    //
    // TAPER sets how many grid steps the correction survives beyond the last
    // real measurement. Past that the field is zero, which is the honest
    // statement: nothing was measured there, so nothing is corrected there.
    const TAPER = 2.5;

    function fillNaN(g, NG, taper) {
      const T = taper == null ? TAPER : taper;
      const a = Float32Array.from(g);
      const depth = new Int16Array(NG * NG).fill(-1);
      for (let i = 0; i < a.length; i++) if (!Number.isNaN(a[i])) depth[i] = 0;
      for (let pass = 1; pass <= 60; pass++) {
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
            if (n) { next[k] = s / n; depth[k] = pass; } else bad++;
          }
        }
        a.set(next);
        if (!bad) break;
      }
      for (let i = 0; i < a.length; i++) {
        if (Number.isNaN(a[i])) { a[i] = 0; continue; }
        if (depth[i] > 0) a[i] *= T > 0 ? Math.max(0, 1 - depth[i] / T) : 1;
      }
      return a;
    }

    // Grid -> full-size displacement maps. Grid points sit at cell centres, so a
    // plain resize lands them in the right places provided canvas/step is an
    // integer — which is why `step` must divide `canvas`.
    function densify(grid, NG, canvas, ramp, out) {
      const small = mat32F(NG, NG, grid);
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
      // Per-pixel counts, not a single frame count: pixels differ in how many
      // frames actually covered them once the framing drifts.
      const a = { canvas, sum: new Float32Array(n), cnt: new Uint16Array(n), frames: 0 };
      if (halves) {
        a.odd = new Float32Array(n); a.even = new Float32Array(n);
        a.cntOdd = new Uint16Array(n); a.cntEven = new Uint16Array(n);
        a.nOdd = 0; a.nEven = 0;
      }
      return a;
    }

    function accumulate(acc, data, cover, index) {
      const s = acc.sum, c = acc.cnt;
      if (cover) {
        for (let i = 0; i < s.length; i++) if (cover[i]) { s[i] += data[i]; c[i]++; }
      } else {
        for (let i = 0; i < s.length; i++) { s[i] += data[i]; c[i]++; }
      }
      acc.frames++;
      if (acc.odd) {
        const odd = index % 2;
        const h = odd ? acc.odd : acc.even, hc = odd ? acc.cntOdd : acc.cntEven;
        if (cover) {
          for (let i = 0; i < h.length; i++) if (cover[i]) { h[i] += data[i]; hc[i]++; }
        } else {
          for (let i = 0; i < h.length; i++) { h[i] += data[i]; hc[i]++; }
        }
        if (odd) acc.nOdd++; else acc.nEven++;
      }
    }

    const finishAcc = (acc) => {
      const out = new Float32Array(acc.sum.length);
      for (let i = 0; i < out.length; i++) out[i] = acc.cnt[i] ? acc.sum[i] / acc.cnt[i] : 0;
      return out;
    };

    // ---- wavelet sharpening ------------------------------------------------
    //
    // The a trous ("with holes") scheme Registax made standard for planetary and
    // solar work. The image is split into scales by repeated blurring:
    //
    //     detail_i = blur_{i-1} - blur_i        (band-limited to that scale)
    //     residual = blur_n                     (everything coarser)
    //     result   = residual + sum(gain_i * detail_i)
    //
    // With every gain at 1 this reconstructs the input exactly, which is the
    // property worth testing — it means the decomposition loses nothing and the
    // gains alone decide the result.
    //
    // The advantage over an unsharp mask is control: a single unsharp radius
    // amplifies one scale and drags noise up with it, while this lifts the
    // scales carrying real solar structure and leaves the finest scale — where
    // sensor and codec noise live — alone, or pulls it down.
    function waveletSharpen(lin, canvas, gains) {
      if (!gains || !gains.length || gains.every((g) => g === 1)) return lin;
      let cur = mat32F(canvas, canvas, lin);
      const detail = [];
      let sigma = 1.0;
      for (let i = 0; i < gains.length; i++) {
        const blurred = new cv.Mat();
        cv.GaussianBlur(cur, blurred, new cv.Size(0, 0), sigma);
        const d = new cv.Mat();
        cv.subtract(cur, blurred, d);
        detail.push(d);
        cur.delete();
        cur = blurred;
        sigma *= 2;                       // octave per scale
      }
      // cur is now the residual; add the scaled detail back on to it.
      for (let i = 0; i < detail.length; i++) {
        if (gains[i] !== 0) cv.addWeighted(cur, 1, detail[i], gains[i], 0, cur);
        detail[i].delete();
      }
      const out = Float32Array.from(cur.data32F);
      cur.delete();
      return out;
    }

    // ---- display -----------------------------------------------------------

    // A percentile stretch, not the astro midtone transfer: the solar disc is a
    // near-uniform bright field and an autostretch built for a dark sky would
    // drive it to white.
    function render(lin, canvas, o) {
      const opt = Object.assign({ lo: 0.2, hi: 99.9, sharpen: 0, sharpenRadius: 2.4,
                                  wavelet: null }, o || {});
      // Sharpen the linear stack, then stretch. Sharpening after the stretch
      // would work on a tone curve that has already compressed the highlights.
      if (opt.wavelet) lin = waveletSharpen(lin, canvas, opt.wavelet);
      const n = lin.length;
      const samp = new Float32Array(Math.ceil(n / 16));
      let j = 0;
      for (let i = 0; i < n; i += 16) samp[j++] = lin[i];
      const s = samp.subarray(0, j).slice().sort();
      // forceLo/forceHi let a second image be rendered through the SAME tone
      // curve. Without that, a before/after panel compares two stretches rather
      // than two stacks, and flatters whichever side got the kinder one.
      const lo = opt.forceLo != null ? opt.forceLo : s[Math.floor((opt.lo / 100) * (j - 1))];
      const hi = opt.forceHi != null ? opt.forceHi : s[Math.floor((opt.hi / 100) * (j - 1))];
      const scale = 255 / Math.max(1e-6, hi - lo);

      let src = new Float32Array(n);
      for (let i = 0; i < n; i++) src[i] = Math.max(0, Math.min(255, (lin[i] - lo) * scale));

      if (opt.sharpen > 0) {
        const m = mat32F(canvas, canvas, src);
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

    // ---- telemetry ---------------------------------------------------------
    //
    // These exist so the app can report what the run actually achieved instead
    // of repeating what the README claims. Every figure below is derived from
    // the user's own frames.

    // Inner-disc mask as a plain byte array, for statistics that must exclude
    // the limb (an enormous permanent edge) and the empty sky around it.
    function innerMask(ref8, o, erodePx) {
      const mask = discMaskMat(ref8, o);
      const inner = new cv.Mat();
      const n = erodePx || 121;
      const k = cv.Mat.ones(n, n, cv.CV_8U);
      cv.erode(mask, inner, k);
      const out = Uint8Array.from(inner.data);
      k.delete(); mask.delete(); inner.delete();
      return out;
    }

    const bandOf = (arr, canvas, s1, s2) => {
      const m = mat32F(canvas, canvas, arr);
      const a = new cv.Mat(), b = new cv.Mat();
      cv.GaussianBlur(m, a, new cv.Size(0, 0), s1);
      cv.GaussianBlur(m, b, new cv.Size(0, 0), s2);
      cv.subtract(a, b, a);
      const out = Float32Array.from(a.data32F);
      m.delete(); a.delete(); b.delete();
      return out;
    };

    function correlate(a, b, mask) {
      let n = 0, sa = 0, sb = 0;
      for (let i = 0; i < a.length; i++) if (mask[i]) { n++; sa += a[i]; sb += b[i]; }
      if (n < 100) return null;
      const ma = sa / n, mb = sb / n;
      let ca = 0, cb = 0, cab = 0;
      for (let i = 0; i < a.length; i++) {
        if (!mask[i]) continue;
        const da = a[i] - ma, db = b[i] - mb;
        ca += da * da; cb += db * db; cab += da * db;
      }
      return cab / Math.sqrt(ca * cb);
    }

    const halfMean = (acc, which) => {
      const src = which === 'odd' ? acc.odd : acc.even;
      const cnt = which === 'odd' ? acc.cntOdd : acc.cntEven;
      const out = new Float32Array(src.length);
      for (let i = 0; i < out.length; i++) out[i] = cnt[i] ? src[i] / cnt[i] : 0;
      return out;
    };

    // Split-half reliability. Odd and even frames are stacked separately, so
    // structure that is real appears in both and noise does not: the
    // correlation between them is the signal fraction, and r/(1-r) is an SNR.
    //
    // This is the only measurement in this project that has not misled. A
    // residual-against-median noise estimate counts genuine fine solar detail
    // as noise, and rates a sharper stack as a worse one.
    function reliability(acc, canvas, mask, s1, s2) {
      if (!acc || !acc.nOdd || !acc.nEven) return null;
      const r = correlate(bandOf(halfMean(acc, 'odd'), canvas, s1, s2),
                          bandOf(halfMean(acc, 'even'), canvas, s1, s2), mask);
      if (r === null || !(r < 1)) return null;
      // SNR = r/(1-r) blows up as r approaches 1: at r = 0.998 a difference of
      // 1e-4 between two stacks swings the ratio by 6%, which is how a coarse
      // band once reported multi-point alignment as 0.94x when a 300-frame A/B
      // put it at 1.19x. Past this point the number is not evidence.
      return { r, snr: r / (1 - r), saturated: r > 0.995 };
    }

    const sdOverMask = (a, mask) => {
      let n = 0, s = 0, s2 = 0;
      for (let i = 0; i < a.length; i++) if (mask[i]) { n++; s += a[i]; s2 += a[i] * a[i]; }
      if (!n) return null;
      return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
    };

    // Noise left in the finished stack. The two half-stacks differ only by
    // noise, so if each half carries sigma_h then sd(odd - even) = sigma_h*sqrt2,
    // and the full stack — twice as many frames — carries sigma_h/sqrt2. Hence
    // sigma_full = sd(odd - even) / 2.
    function stackNoise(acc, mask) {
      if (!acc || !acc.nOdd || !acc.nEven) return null;
      const o = halfMean(acc, 'odd'), e = halfMean(acc, 'even');
      const d = new Float32Array(o.length);
      for (let i = 0; i < d.length; i++) d[i] = o[i] - e[i];
      const sd = sdOverMask(d, mask);
      return sd === null ? null : sd / 2;
    }

    // Noise in one frame, estimated against the stack. The stack is a far better
    // estimate of the truth than any single frame, so the difference is
    // dominated by that frame's own noise.
    function frameNoise(frame, stack, mask) {
      const d = new Float32Array(frame.length);
      for (let i = 0; i < d.length; i++) d[i] = frame[i] - stack[i];
      return sdOverMask(d, mask);
    }

    // ---- the selection trade-off -------------------------------------------
    //
    // Lucky imaging says keep the sharpest few percent of frames; plain
    // averaging says keep everything. Which is right depends on the footage, so
    // rather than assume, measure both ends and everything between.
    //
    // The statistic is reproducible fine-detail amplitude at each keep fraction:
    //
    //     A(f) = sqrt(r_f) * rms_fine(stack of the best f)
    //
    // Split-half SNR on its own cannot answer this. Blur is reproducible, so r
    // keeps climbing as blurrier frames are added and pure SNR would always
    // conclude "use everything" however bad the seeing was. The sqrt(r) factor
    // discounts noise while rms_fine falls when blurred frames dilute the
    // detail, so the product peaks at the genuine balance point.

    const FRACTIONS = [0.02, 0.05, 0.10, 0.25, 0.50, 1.00];

    // Per-frame quality, on a full-resolution crop at the disc centre. Mid-band
    // energy over high-band energy: real solar structure is mid-band and both
    // sensor and codec noise are broadband, so the ratio ranks by sharpness
    // rather than by how grainy a frame happens to be. Ranking on raw
    // high-frequency energy instead selects the noisiest frames — measured.
    function frameQuality(warped, canvas, size) {
      const s = Math.min(size || 700, canvas);
      const x0 = ((canvas - s) / 2) | 0;
      const roi = warped.roi(new cv.Rect(x0, x0, s, s));
      const f = new cv.Mat();
      roi.convertTo(f, cv.CV_32F);
      const a = new cv.Mat(), b = new cv.Mat(), c = new cv.Mat(), d = new cv.Mat();
      cv.GaussianBlur(f, a, new cv.Size(0, 0), 1.4);
      cv.GaussianBlur(f, b, new cv.Size(0, 0), 3.2);
      cv.subtract(a, b, a);
      cv.GaussianBlur(f, c, new cv.Size(0, 0), 0.6);
      cv.GaussianBlur(f, d, new cv.Size(0, 0), 1.2);
      cv.subtract(c, d, c);
      let mid = 0, hi = 0;
      const A = a.data32F, C = c.data32F;
      for (let i = 0; i < A.length; i++) { mid += A[i] * A[i]; hi += C[i] * C[i]; }
      roi.delete(); f.delete(); a.delete(); b.delete(); c.delete(); d.delete();
      return mid / (hi + 1e-9);
    }

    // Nested accumulators, one per keep fraction, over a small region of
    // interest. A frame in the best 2% also belongs to every larger fraction, so
    // one pass in presentation order fills all of them.
    function newCurve(size, cx, cy) {
      return {
        size, cx, cy,
        sets: FRACTIONS.map(() => ({
          sum: new Float32Array(size * size),
          odd: new Float32Array(size * size),
          even: new Float32Array(size * size),
          n: 0, nOdd: 0, nEven: 0,
        })),
      };
    }

    function accumulateCurve(curve, warped, rankFrac, seq) {
      const s = curve.size;
      const x0 = Math.max(0, Math.min(warped.cols - s, (curve.cx - s / 2) | 0));
      const y0 = Math.max(0, Math.min(warped.rows - s, (curve.cy - s / 2) | 0));
      const roi = warped.roi(new cv.Rect(x0, y0, s, s));
      const buf = new Uint8Array(roi.data);      // roi is a view; copy to read rows contiguously
      roi.delete();
      for (let k = 0; k < FRACTIONS.length; k++) {
        if (rankFrac > FRACTIONS[k]) continue;   // this frame is not in the best f
        const set = curve.sets[k];
        const half = seq % 2 ? set.odd : set.even;
        for (let i = 0; i < buf.length; i++) { set.sum[i] += buf[i]; half[i] += buf[i]; }
        set.n++;
        if (seq % 2) set.nOdd++; else set.nEven++;
      }
    }

    function curveResult(curve) {
      const out = [];
      for (let k = 0; k < FRACTIONS.length; k++) {
        const set = curve.sets[k];
        if (set.n < 4 || set.nOdd < 2 || set.nEven < 2) continue;
        const s = curve.size;
        const mean = new Float32Array(set.sum.length);
        for (let i = 0; i < mean.length; i++) mean[i] = set.sum[i] / set.n;
        const o = new Float32Array(set.odd.length), e = new Float32Array(set.even.length);
        for (let i = 0; i < o.length; i++) { o[i] = set.odd[i] / set.nOdd; e[i] = set.even[i] / set.nEven; }
        const full = new Uint8Array(mean.length).fill(1);
        const r = correlate(bandOf(o, s, 1.4, 3.2), bandOf(e, s, 1.4, 3.2), full);
        const fine = bandOf(mean, s, 1.4, 3.2);
        let sq = 0;
        for (let i = 0; i < fine.length; i++) sq += fine[i] * fine[i];
        const rms = Math.sqrt(sq / fine.length);
        if (r === null || !(r > 0)) continue;
        out.push({ fraction: FRACTIONS[k], frames: set.n, r, rms, amplitude: Math.sqrt(r) * rms });
      }
      if (!out.length) return null;
      let best = out[0];
      for (const p of out) if (p.amplitude > best.amplitude) best = p;
      const all = out[out.length - 1];
      return {
        points: out,
        bestFraction: best.fraction,
        bestFrames: best.frames,
        gainOverAll: all.amplitude > 0 ? best.amplitude / all.amplitude : null,
      };
    }

    // cv.matFromArray(..., Array.from(f32)) boxes every element into a regular
    // JS array before copying it in. On a 2100x2100 map that measured 223 ms per
    // frame — 46% of the whole second pass. Writing into data32F is a memcpy.
    function mat32F(rows, cols, arr) {
      const m = new cv.Mat(rows, cols, cv.CV_32F);
      m.data32F.set(arr);
      return m;
    }

    // Cheap downsample for the live preview: integer stride and a min/max
    // stretch, so it costs a fraction of a full render and can run mid-stack.
    function preview(lin, canvas, size) {
      const step = Math.max(1, Math.floor(canvas / size));
      const n = Math.floor(canvas / step);
      const small = new Float32Array(n * n);
      for (let y = 0, k = 0; y < n; y++) {
        const row = y * step * canvas;
        for (let x = 0; x < n; x++, k++) small[k] = lin[row + x * step];
      }
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < small.length; i++) {
        if (small[i] < lo) lo = small[i];
        if (small[i] > hi) hi = small[i];
      }
      const scale = 255 / Math.max(1e-6, hi - lo);
      const rgba = new Uint8ClampedArray(n * n * 4);
      for (let i = 0, q = 0; i < small.length; i++, q += 4) {
        const v = (small[i] - lo) * scale;
        rgba[q] = rgba[q + 1] = rgba[q + 2] = v;
        rgba[q + 3] = 255;
      }
      return { rgba, size: n };
    }

    return {
      DEFAULTS, toGray, discCentroid, grayMat, centreShift, quarterNorm,
      solveGlobal, warpToCanvas, buildAPs, discMaskMat, measureField,
      fillNaN, densify, ramps, subpixel,
      newAccumulator, accumulate, finishAcc, render,
      innerMask, reliability, stackNoise, frameNoise, preview, halfMean, mat32F, releaseScratch,
      waveletSharpen,
      discGeometry, fitLimb, fitCircleLS, circumcircle, coarseCentre, coverageOf,
      FRACTIONS, frameQuality, newCurve, accumulateCurve, curveResult,
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createPipeline };
  else root.createPipeline = createPipeline;
})(typeof self !== 'undefined' ? self : globalThis);
