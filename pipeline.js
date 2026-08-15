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

    // Totality inverts the geometry: the bright region is an annulus of corona
    // around a dark lunar disc, so its centroid sits at the Moon's centre and
    // the inside/outside sense test cannot separate the two boundaries — both
    // enclose the centroid, and fitLimb rejects everything.
    //
    // The lunar limb is then the INNER boundary: the boundary points nearer the
    // centroid than the outer edge of the corona. Fitting those alone recovers
    // it. This is the only geometry where the disc of interest is the dark one.
    function fitInnerLimb(geom, o) {
      const pts = geom.edge, n = pts.length / 2;
      if (n < 60) return null;
      const rad = new Float64Array(n);
      for (let i = 0; i < n; i++) rad[i] = Math.hypot(pts[2*i] - geom.cx, pts[2*i+1] - geom.cy);
      const sorted = Float64Array.from(rad).sort();
      const cut = sorted[Math.floor(n * 0.45)];      // inner boundary of the ring
      const inner = [];
      for (let i = 0; i < n; i++) if (rad[i] <= cut) inner.push(pts[2*i], pts[2*i+1]);
      if (inner.length < 120) return null;
      // reuse the circle machinery, with the sense test disabled by centring the
      // search on the inner points themselves
      let sx = 0, sy = 0;
      for (let i = 0; i < inner.length; i += 2) { sx += inner[i]; sy += inner[i+1]; }
      const g2 = { edge: inner, cx: sx / (inner.length/2), cy: sy / (inner.length/2) };
      // the inner-boundary centroid lies inside its own circle, so inside:true
      return fitLimb(g2, Object.assign({ inside: true }, o || {}));
    }

    function fitLimb(geom, o) {
      const opt = Object.assign({ tol: 2.5, iters: 400, minInliers: 0.15, rHint: null, rTol: 0.25,
                                  inside: true }, o || {});
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
        // Sense separates the two limbs: the lit region lies INSIDE the solar
        // circle and OUTSIDE the lunar one, though their radii are similar.
        const litInside = Math.hypot(geom.cx - c.cx, geom.cy - c.cy) < c.r;
        if (litInside !== opt.inside) continue;
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
    // Threshold and erosion both have to suit the target. Masking at 0.45 of peak
    // and eroding by 61 px is right for a bright full disc, and fatal for the
    // corona at totality: the threshold keeps only a thin ring and eroding a thin
    // ring by 61 px leaves almost nothing. That produced 5 alignment points on a
    // 21x21 grid, so multi-point alignment had nothing to work with.
    //
    // The erosion exists to keep patches off the solar limb, where half the patch
    // is empty sky and the edge dominates the match. A fainter, thinner target
    // needs a proportionally smaller guard band.
    function buildAPs(refMat, o) {
      const want = o.minAPs || 24;
      const rungs = [
        { frac: o.discFrac, erode: 61 },
        { frac: 0.25, erode: 31 },
        { frac: 0.12, erode: 15 },
      ];
      let best = null;
      for (const rung of rungs) {
        const r = buildAPsAt(refMat, o, rung);
        if (r.aps.length >= want) { r.rung = rung; return r; }
        if (!best || r.aps.length > best.aps.length) { best = r; best.rung = rung; }
        else for (const a of r.aps) if (a.tmpl) a.tmpl.delete();   // discard the losers
      }
      return best;
    }

    function buildAPsAt(refMat, o, rung) {
      const NG = Math.round(o.canvas / o.step);
      const mask = discMaskMat(refMat, Object.assign({}, o, { discFrac: rung.frac }));
      const inner = new cv.Mat();
      const e = Math.max(3, rung.erode | 1);
      const k = cv.Mat.ones(e, e, cv.CV_8U);
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

    // Weights interpolate the same way the displacement field does, but cubic
    // resampling overshoots, so clamp after. Cells with no quality measurement
    // (empty sky) weight 1: neutral, not zero, or the stack would lose them.
    function densifyWeights(grid, NG, canvas, out, floorW) {
      const g = new Float32Array(grid.length);
      for (let i = 0; i < g.length; i++) g[i] = grid[i] > 0 ? grid[i] : 1;
      const small = mat32F(NG, NG, g);
      const blur = new cv.Mat();
      cv.GaussianBlur(small, blur, new cv.Size(0, 0), 0.9);
      const big = new cv.Mat();
      cv.resize(blur, big, new cv.Size(canvas, canvas), 0, 0, cv.INTER_CUBIC);
      small.delete(); blur.delete();
      const d = big.data32F, fl = floorW == null ? 0.05 : floorW;
      for (let i = 0; i < out.length; i++) out[i] = Math.max(fl, Math.min(1, d[i]));
      big.delete();
    }

    function ramps(canvas) {
      const X = new Float32Array(canvas * canvas), Y = new Float32Array(canvas * canvas);
      for (let y = 0, i = 0; y < canvas; y++) {
        for (let x = 0; x < canvas; x++, i++) { X[i] = x; Y[i] = y; }
      }
      return { X, Y };
    }

    // Per-cell sharpness on the alignment grid: the mid-band energy over the
    // high-band energy, the same noise-normalised ratio used for whole-frame
    // ranking. Raw high-frequency energy would grade grain, which is how the
    // first whole-frame metric came to select the noisiest frames.
    //
    // Measured per cell rather than per frame because seeing is local. A frame
    // can be sharp on one side of the disc and soft on the other, and throwing
    // the whole frame away discards the good half with the bad.
    function cellQuality(warped, canvas, NG, o) {
      const step = canvas / NG;
      const q = new Float32Array(NG * NG).fill(NaN);
      const f = new cv.Mat(), a = new cv.Mat(), b = new cv.Mat(), c = new cv.Mat(), d = new cv.Mat();
      const pad = Math.round(step * 0.5);
      for (let j = 0; j < NG; j++) {
        for (let i = 0; i < NG; i++) {
          const x0 = Math.round(i * step), y0 = Math.round(j * step);
          const w = Math.min(Math.round(step) + pad, canvas - x0);
          const h = Math.min(Math.round(step) + pad, canvas - y0);
          if (w < 16 || h < 16) continue;
          const roi = warped.roi(new cv.Rect(x0, y0, w, h));
          roi.convertTo(f, cv.CV_32F);
          roi.delete();
          // Gate on the mean, not the peak. Zero-mean noise raises the maximum
          // of a 150x150 cell by several sigma, so a peak-based gate admits
          // empty sky as soon as noise exceeds about 4 DN -- at sigma 8 it
          // graded 8 extra cells that contain nothing but grain. The mean is
          // unmoved by zero-mean noise.
          const mm = cv.minMaxLoc(f);
          if (mm.maxVal < 12 || cv.mean(f)[0] < 5) continue;
          cv.GaussianBlur(f, a, new cv.Size(0, 0), 1.4);
          cv.GaussianBlur(f, b, new cv.Size(0, 0), 3.2);
          cv.subtract(a, b, a);
          cv.GaussianBlur(f, c, new cv.Size(0, 0), 3.2);
          cv.GaussianBlur(f, d, new cv.Size(0, 0), 7.0);
          cv.subtract(c, d, c);
          let fine = 0, mid = 0;
          const A = a.data32F, C = c.data32F;
          for (let k = 0; k < A.length; k++) { fine += A[k] * A[k]; mid += C[k] * C[k]; }
          q[j * NG + i] = fine / (mid + 1e-9);
        }
      }
      for (const m of [f, a, b, c, d]) m.delete();
      return q;
    }

    // Turn per-cell qualities into per-cell weights, against a reference level
    // for each cell taken across all frames. Weighting is relative to the same
    // place in other frames, never to other places in the same frame — the disc
    // centre is intrinsically busier than the limb and would otherwise dominate.
    function cellWeights(q, ref, NG, power, floorW) {
      const w = new Float32Array(NG * NG);
      const p = power == null ? 2 : power, fl = floorW == null ? 0.05 : floorW;
      for (let i = 0; i < w.length; i++) {
        const qi = q[i], ri = ref[i];
        if (!(qi > 0) || !(ri > 0)) { w[i] = NaN; continue; }
        w[i] = Math.max(fl, Math.min(1, Math.pow(qi / ri, p)));
      }
      return w;
    }

    // ---- accumulation ------------------------------------------------------
    //
    // JavaScript typed arrays, not cv.Mat, for the same reason as AstroFuse: the
    // binding limit on this build is the wasm32 heap, and keeping the
    // accumulators off it makes frame count cost nothing.

    function newAccumulator(canvas, halves, weighted) {
      const n = canvas * canvas;
      // Per-pixel counts, not a single frame count: pixels differ in how many
      // frames actually covered them once the framing drifts. With seeing
      // weighting the count becomes a sum of weights, so it has to be float.
      const C = weighted ? Float32Array : Uint16Array;
      const a = { canvas, sum: new Float32Array(n), cnt: new C(n), frames: 0, weighted: !!weighted };
      if (halves) {
        a.odd = new Float32Array(n); a.even = new Float32Array(n);
        a.cntOdd = new C(n); a.cntEven = new C(n);
        a.nOdd = 0; a.nEven = 0;
      }
      return a;
    }

    function accumulate(acc, data, cover, index, weight) {
      // An accumulator built without `weighted` counts in Uint16, so `cnt += 0.75`
      // truncates to zero and finishAcc then divides a real sum by nothing: the
      // stack comes out uniformly black with no error anywhere. Refuse the
      // combination rather than lose the data quietly.
      if (weight && !acc.weighted) {
        throw new Error('accumulate: weights require newAccumulator(canvas, halves, true)');
      }
      const s = acc.sum, c = acc.cnt;
      if (weight) {
        for (let i = 0; i < s.length; i++) {
          if (cover && !cover[i]) continue;
          const w = weight[i];
          if (!(w > 0)) continue;
          s[i] += data[i] * w; c[i] += w;
        }
      } else if (cover) {
        for (let i = 0; i < s.length; i++) if (cover[i]) { s[i] += data[i]; c[i]++; }
      } else {
        for (let i = 0; i < s.length; i++) { s[i] += data[i]; c[i]++; }
      }
      acc.frames++;
      if (acc.odd) {
        const odd = index % 2;
        const h = odd ? acc.odd : acc.even, hc = odd ? acc.cntOdd : acc.cntEven;
        if (weight) {
          for (let i = 0; i < h.length; i++) {
            if (cover && !cover[i]) continue;
            const w = weight[i];
            if (!(w > 0)) continue;
            h[i] += data[i] * w; hc[i] += w;
          }
        } else if (cover) {
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

    // ---- point spread function, measured from a limb -----------------------
    //
    // A limb is a step edge of known geometry, so its edge-spread function gives
    // the PSF directly — no guessing a shape, and no optimising one against a
    // sharpness score, which would happily converge on amplified noise.
    //
    // Two details decide whether the answer is usable:
    //
    // Each profile is normalised against its OWN dark and bright levels before
    // averaging. Limb darkening means the photosphere behind one part of the arc
    // is not as bright as behind another, and binning by radius alone mixes
    // those plateaux and smears the edge. Skipping this step measured the blur
    // 37% too wide and the recovered PSF failed to re-project onto its own data
    // (18% mismatch, against 4% once normalised).
    //
    // The lunar limb beats the solar one where an eclipse offers it: the Moon
    // has no atmosphere and no limb darkening, so it is very nearly an ideal
    // knife edge. Measured on the same stack, the solar limb reads 1.44x wider.

    function bilinear(img, w, h, x, y) {
      const x0 = Math.max(0, Math.min(w - 2, Math.floor(x)));
      const y0 = Math.max(0, Math.min(h - 2, Math.floor(y)));
      const fx = x - x0, fy = y - y0, i = y0 * w + x0;
      return img[i] * (1 - fx) * (1 - fy) + img[i + 1] * fx * (1 - fy)
           + img[i + w] * (1 - fx) * fy + img[i + w + 1] * fx * fy;
    }

    // Average edge profile around a fitted circle, each sample normalised to its
    // own 0..1 range. `sign` is +1 when the bright side is outside the circle.
    function edgeProfile(img, w, h, circle, sign, o) {
      const span = (o && o.span) || 18, step = (o && o.step) || 0.1;
      // Contrast and flatness thresholds have to scale with the target. A solar
      // crescent gives a flat bright plateau; the corona at totality is faint
      // and falls off with radius, so fixed limits reject every profile and the
      // measurement reports "not clean enough" on perfectly usable data.
      const minContrast = (o && o.minContrast) || 40;
      const rippleFrac = (o && o.rippleFrac) || 0.06;
      const n = Math.round((2 * span) / step) + 1;
      const acc = new Float64Array(n);
      const off = new Float64Array(n);
      for (let i = 0; i < n; i++) off[i] = -span + i * step;
      const edge = Math.round(40 * (0.1 / step));
      let used = 0;
      for (let a = 0; a < 4000; a++) {
        const t = (a / 4000) * Math.PI * 2;
        const nx = Math.cos(t) * sign, ny = Math.sin(t) * sign;
        const px = circle.cx + Math.cos(t) * circle.r, py = circle.cy + Math.sin(t) * circle.r;
        if (px < span + 2 || py < span + 2 || px > w - span - 2 || py > h - span - 2) continue;
        const prof = new Float64Array(n);
        for (let i = 0; i < n; i++) prof[i] = bilinear(img, w, h, px + nx * off[i], py + ny * off[i]);
        let dark = 0, bright = 0;
        for (let i = 0; i < edge; i++) { dark += prof[i]; bright += prof[n - 1 - i]; }
        dark /= edge; bright /= edge;
        if (bright - dark < minContrast) continue;          // not an edge here
        let vd = 0, vb = 0;
        for (let i = 0; i < edge; i++) {
          vd += (prof[i] - dark) ** 2; vb += (prof[n - 1 - i] - bright) ** 2;
        }
        const ripple = rippleFrac * (bright - dark);
        if (Math.sqrt(vd / edge) > ripple || Math.sqrt(vb / edge) > ripple) continue;  // not flat either side
        const k = 1 / (bright - dark);
        for (let i = 0; i < n; i++) acc[i] += (prof[i] - dark) * k;
        used++;
      }
      if (used < 40) return null;
      const esf = new Float64Array(n);
      for (let i = 0; i < n; i++) esf[i] = acc[i] / used;
      return { off, esf, used, step };
    }

    // PSF from the edge, without assuming a shape. For a radially symmetric
    // system the MTF is |FT(LSF)|, so rotating that into a 2D transfer function
    // and inverting gives the PSF — gaussian for seeing, a filled disc for
    // defocus, heavy-tailed for scattering, whatever is actually there.
    function psfFromProfile(prof, o) {
      const { off, esf, step } = prof;
      const n = off.length;
      const lsf = new Float64Array(n);
      for (let i = 1; i < n - 1; i++) lsf[i] = Math.max(0, (esf[i + 1] - esf[i - 1]) / (2 * step));
      let sum = 0;
      for (let i = 0; i < n; i++) sum += lsf[i];
      if (sum <= 0) return null;
      for (let i = 0; i < n; i++) lsf[i] /= sum;

      let centre = 0;
      for (let i = 0; i < n; i++) centre += lsf[i] * off[i];
      let v = 0, k4 = 0;
      for (let i = 0; i < n; i++) v += lsf[i] * (off[i] - centre) ** 2;
      const sigma = Math.sqrt(v);
      for (let i = 0; i < n; i++) k4 += lsf[i] * (off[i] - centre) ** 4;
      const kurtosis = k4 / (v * v);

      // 1-D transform of the line spread, on a grid of `step` px
      const N = 512;
      const line = new Float64Array(N);
      for (let i = 0; i < n; i++) {
        const idx = Math.round((off[i] - centre) / step);
        const j = ((idx % N) + N) % N;
        line[j] += lsf[i];
      }
      const half = N / 2;
      const mtf = new Float64Array(half + 1);
      for (let f = 0; f <= half; f++) {
        let re = 0, im = 0;
        for (let t = 0; t < N; t++) {
          const ph = (-2 * Math.PI * f * t) / N;
          re += line[t] * Math.cos(ph); im += line[t] * Math.sin(ph);
        }
        mtf[f] = Math.hypot(re, im);
      }
      const m0 = mtf[0] || 1;
      for (let f = 0; f <= half; f++) mtf[f] /= m0;
      // frequency of bin f, in cycles per pixel
      const freqOf = (f) => f / (N * step);
      const fmax = freqOf(half);

      // rotate into a 2-D transfer function and invert it
      const K = (o && o.kernel) || 129;
      const otf = new cv.Mat(K, K, cv.CV_32FC2);
      const od = otf.data32F;
      for (let y = 0; y < K; y++) {
        const fy = (y <= K / 2 ? y : y - K) / K;
        for (let x = 0; x < K; x++) {
          const fx = (x <= K / 2 ? x : x - K) / K;
          const fr = Math.hypot(fx, fy);
          let val;
          if (fr >= fmax) val = 0;
          else {
            const p = fr * N * step;
            const i0 = Math.floor(p), t = p - i0;
            val = i0 + 1 <= half ? mtf[i0] * (1 - t) + mtf[i0 + 1] * t : 0;
          }
          const q = (y * K + x) * 2;
          od[q] = val; od[q + 1] = 0;
        }
      }
      const spatial = new cv.Mat();
      cv.dft(otf, spatial, cv.DFT_INVERSE | cv.DFT_REAL_OUTPUT | cv.DFT_SCALE);
      otf.delete();

      // shift the origin to the centre, clip and normalise
      const psf = new Float32Array(K * K);
      let tot = 0;
      for (let y = 0; y < K; y++) {
        for (let x = 0; x < K; x++) {
          const sy = (y + K / 2 | 0) % K, sx = (x + K / 2 | 0) % K;
          const val = Math.max(0, spatial.data32F[sy * K + sx]);
          psf[y * K + x] = val; tot += val;
        }
      }
      spatial.delete();
      if (!(tot > 0)) return null;
      for (let i = 0; i < psf.length; i++) psf[i] /= tot;

      // Trim by enclosed energy, with a hard cap. A heavy-tailed PSF needs a
      // very large radius to reach the last half percent, and convolution cost
      // grows with the square of the kernel: 41x41 is a tenth of the work of
      // 129x129, for a fraction of a percent of the energy.
      const cxk = K >> 1;
      const rad = [];
      for (let y = 0; y < K; y++) for (let x = 0; x < K; x++)
        rad.push([Math.hypot(x - cxk, y - cxk), psf[y * K + x]]);
      rad.sort((a, b) => a[0] - b[0]);
      const frac = (o && o.enclose) || 0.98;
      const cap = (o && o.maxHalf) || 20;
      let cum = 0, rEnc = cxk;
      for (const [rr, val] of rad) { cum += val; if (cum >= frac) { rEnc = rr; break; } }
      let hk = Math.max(3, Math.min(cxk, cap, Math.ceil(rEnc)));
      const KK = hk * 2 + 1;
      const out = new Float32Array(KK * KK);
      let t2 = 0;
      for (let y = 0; y < KK; y++) for (let x = 0; x < KK; x++) {
        const val = psf[(y + cxk - hk) * K + (x + cxk - hk)];
        out[y * KK + x] = val; t2 += val;
      }
      for (let i = 0; i < out.length; i++) out[i] /= t2;

      // Re-project and compare: if the PSF cannot reproduce the edge it was
      // measured from, it is not a PSF worth deconvolving with. Measured on the
      // untrimmed kernel, so this describes the recovery rather than the trim.
      const proj = new Float64Array(K);
      for (let y = 0; y < K; y++) for (let x = 0; x < K; x++) proj[x] += psf[y * K + x];
      const meas = new Float64Array(K);
      for (let i = 0; i < n; i++) {
        const idx = Math.round(off[i] - centre) + cxk;
        if (idx >= 0 && idx < K) meas[idx] += lsf[i];
      }
      let ps = 0, ms = 0;
      for (let i = 0; i < K; i++) { ps += proj[i]; ms += meas[i]; }
      let tv = 0;
      for (let i = 0; i < K; i++) tv += Math.abs(proj[i] / ps - meas[i] / ms);
      return { psf: out, k: KK, sigma, fwhm: 2.3548 * sigma, kurtosis,
               residual: tv / 2, profiles: prof.used };
    }

    // A support mask from the geometry already fitted. During an eclipse the
    // Moon really is black and the sky beyond the solar limb really is empty, so
    // those regions are known rather than inferred — and that is exactly where
    // the ringing appeared. Constraining them removes it by construction instead
    // of by smoothing everything.
    //
    // Edges are feathered: a hard support boundary is itself a step, and would
    // simply move the ringing rather than remove it.
    function buildSupport(canvas, regions, feather) {
      const f = feather || 6;
      const sup = new Float32Array(canvas * canvas).fill(1);
      for (const reg of regions || []) {
        const { cx, cy, r, mode } = reg;      // mode 'inside' | 'outside' is the DARK side
        for (let y = 0, i = 0; y < canvas; y++) {
          for (let x = 0; x < canvas; x++, i++) {
            const d = Math.hypot(x - cx, y - cy) - r;
            // signed distance into the dark region
            const into = mode === 'inside' ? -d : d;
            if (into <= 0) continue;
            const t = Math.min(1, into / f);
            const keep = 1 - t;
            if (keep < sup[i]) sup[i] = keep;
          }
        }
      }
      return sup;
    }

    // Overshoot at a fitted limb, in units of the local noise. Ringing is
    // otherwise judged by eye, and this conversation has shown repeatedly that
    // eyes and badly-chosen metrics both mislead. With the circle already known,
    // the radial profile gives the number directly — and an automatic place to
    // stop iterating.
    function measureRinging(lin, canvas, circle, sign, o) {
      const span = (o && o.span) || 40, step = 0.25;
      const n = Math.round((2 * span) / step) + 1;
      const acc = new Float64Array(n);
      let used = 0;
      for (let a = 0; a < 1440; a++) {
        const t = (a / 1440) * Math.PI * 2;
        const nx = Math.cos(t) * sign, ny = Math.sin(t) * sign;
        const px = circle.cx + Math.cos(t) * circle.r, py = circle.cy + Math.sin(t) * circle.r;
        if (px < span + 2 || py < span + 2 || px > canvas - span - 2 || py > canvas - span - 2) continue;
        for (let i = 0; i < n; i++) {
          acc[i] += bilinear(lin, canvas, canvas, px + nx * (-span + i * step),
                                                  py + ny * (-span + i * step));
        }
        used++;
      }
      if (!used) return null;
      for (let i = 0; i < n; i++) acc[i] /= used;
      // plateau on the bright side, measured well away from the edge
      const tail = Math.round(n * 0.25);
      let plateau = 0;
      for (let i = n - tail; i < n; i++) plateau += acc[i];
      plateau /= tail;
      let dark = 0;
      for (let i = 0; i < tail; i++) dark += acc[i];
      dark /= tail;
      // scatter of the plateau, as a noise yardstick
      let v = 0;
      for (let i = n - tail; i < n; i++) v += (acc[i] - plateau) ** 2;
      const noise = Math.sqrt(v / tail) + 1e-6;
      // peak excursion just inside the bright side, and just inside the dark side
      let over = 0, under = 0;
      const mid = n >> 1;
      for (let i = mid; i < n - tail; i++) over = Math.max(over, acc[i] - plateau);
      for (let i = tail; i < mid; i++) under = Math.max(under, dark - acc[i]);
      return { overshoot: over, undershoot: under, plateau, dark, noise,
               overshootSigma: over / noise, profile: Array.from(acc) };
    }

    // Richardson-Lucy, with the three things that stop it ringing on this data:
    //
    //   support     - regions known to be dark are held there, so the algorithm
    //                 cannot invent structure in the Moon's shadow or the sky
    //   saturation  - a clipped pixel says "at least this bright", not "exactly
    //                 this"; correcting towards it makes the model fight data
    //                 that cannot express the answer
    //   tv          - total-variation regularisation, which suppresses ringing
    //                 while preserving edges, unlike Tikhonov or Wiener which
    //                 simply smooth
    function richardsonLucy(lin, canvas, psf, k, iters, o) {
      const opt = Object.assign({ support: null, darkLevel: 0, satLevel: 254, tv: 0 }, o || {});
      const img = mat32F(canvas, canvas, lin);
      const kern = mat32F(k, k, psf);
      const flip = new cv.Mat();
      cv.flip(kern, flip, -1);
      let est = img.clone();
      const blur = new cv.Mat(), ratio = new cv.Mat(), corr = new cv.Mat();
      // Scaled to the data, not a fixed 1e-6. Richardson-Lucy divides by the
      // blurred estimate, and in a dark sky that tends to zero: with a tiny
      // epsilon the ratio explodes and the result diverges to hundreds of DN on
      // an 8-bit image. That looks like catastrophic ringing and is not.
      let mean = 0;
      for (let i = 0; i < lin.length; i++) mean += lin[i];
      mean /= lin.length;
      const floor = Math.max(1e-4, mean * 1e-3);
      const eps = new cv.Mat(canvas, canvas, cv.CV_32F, new cv.Scalar(floor));
      const ratioCap = (o && o.ratioCap) || 4;
      let maxIn = 0;
      for (let i = 0; i < lin.length; i++) if (lin[i] > maxIn) maxIn = lin[i];
      const ceiling = (o && o.ceiling) || maxIn * 1.05;
      const anchor = new cv.Point(-1, -1);

      // pixels at or above the clipping level carry no usable correction
      const sat = [];
      for (let i = 0; i < lin.length; i++) if (lin[i] >= opt.satLevel) sat.push(i);

      const gx = new cv.Mat(), gy = new cv.Mat(), mag = new cv.Mat();
      const nx = new cv.Mat(), ny = new cv.Mat(), dxx = new cv.Mat(), dyy = new cv.Mat();

      for (let it = 0; it < iters; it++) {
        cv.filter2D(est, blur, cv.CV_32F, kern, anchor, 0, cv.BORDER_REPLICATE);
        cv.add(blur, eps, blur);
        cv.divide(img, blur, ratio);
        {
          // Cap the correction. An unbounded multiplicative update is what makes
          // RL unstable at low signal; the cap costs a little convergence speed
          // and buys a result that stays finite.
          const rd = ratio.data32F;
          for (let i = 0; i < rd.length; i++) if (rd[i] > ratioCap) rd[i] = ratioCap;
          for (const i of sat) rd[i] = 1;
        }
        cv.filter2D(ratio, corr, cv.CV_32F, flip, anchor, 0, cv.BORDER_REPLICATE);
        cv.multiply(est, corr, est);

        if (opt.tv > 0) {
          // factor = 1 / (1 - lambda * div(grad u / |grad u|))
          cv.Sobel(est, gx, cv.CV_32F, 1, 0, 3);
          cv.Sobel(est, gy, cv.CV_32F, 0, 1, 3);
          cv.magnitude(gx, gy, mag);
          cv.add(mag, eps, mag);
          cv.divide(gx, mag, nx);
          cv.divide(gy, mag, ny);
          cv.Sobel(nx, dxx, cv.CV_32F, 1, 0, 3);
          cv.Sobel(ny, dyy, cv.CV_32F, 0, 1, 3);
          cv.add(dxx, dyy, dxx);
          const dv = dxx.data32F, ed = est.data32F;
          for (let i = 0; i < ed.length; i++) {
            let f = 1 / (1 - opt.tv * dv[i]);
            if (!(f > 0.5)) f = 0.5; else if (f > 1.5) f = 1.5;   // keep it stable
            ed[i] *= f;
          }
        }

        {
          // A physical ceiling. The scene has bounded brightness, and a
          // multiplicative update next to a hard-zero sky otherwise compounds:
          // capping the per-iteration ratio at 4 still allows 4^20 over a run.
          const ed = est.data32F;
          for (let i = 0; i < ed.length; i++) {
            if (ed[i] > ceiling) ed[i] = ceiling;
            else if (!(ed[i] >= 0)) ed[i] = 0;
          }
        }

        if (opt.support) {
          const ed = est.data32F, su = opt.support;
          for (let i = 0; i < ed.length; i++) ed[i] = ed[i] * su[i] + opt.darkLevel * (1 - su[i]);
        }
      }
      const out = Float32Array.from(est.data32F);
      for (const m of [img, kern, flip, est, blur, ratio, corr, eps,
                       gx, gy, mag, nx, ny, dxx, dyy]) m.delete();
      return out;
    }

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
    // Band ratio, fine over mid. Both bands are signal-dominated, so the ratio
    // measures the shape of the spectrum: blur removes fine detail faster than
    // mid detail and the ratio falls. Scaling the image scales both bands
    // equally, so it is invariant to contrast.
    //
    // This replaces a fine-over-noise-band ratio (1.4-3.2 over 0.6-1.2) that was
    // non-monotonic in blur. Blurring suppresses 0.6-1.2 faster than it
    // suppresses 1.4-3.2, so the old ratio ROSE with blur unless noise held the
    // denominator up. On a textured synthetic disc, noise added after the blur
    // as a sensor does:
    //
    //   sensor noise   blur 0   blur 1.0   blur 2.5
    //   sigma 0          4.18       8.50      24.71   backwards
    //   sigma 2          3.16       4.49       3.32   peaks at 1.0 px
    //   sigma 4          2.00       2.14       1.18   peaks at 1.0 px
    //   sigma 8          0.94       0.85       0.48   correct
    //
    // Consecutive aligned frames of the real footage differ by sigma 1.05 DN, so
    // the old metric sat in its backwards regime on exactly the material it was
    // written for, and ranked a 1 px-blurred frame above a sharp one.
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
      cv.GaussianBlur(f, c, new cv.Size(0, 0), 3.2);
      cv.GaussianBlur(f, d, new cv.Size(0, 0), 7.0);
      cv.subtract(c, d, c);
      let fine = 0, mid = 0;
      const A = a.data32F, C = c.data32F;
      for (let i = 0; i < A.length; i++) { fine += A[i] * A[i]; mid += C[i] * C[i]; }
      roi.delete(); f.delete(); a.delete(); b.delete(); c.delete(); d.delete();
      return fine / (mid + 1e-9);
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
      // A submatrix keeps its parent's row stride and reports isContinuous
      // false, and the `.data` accessor ignores stride: it hands back
      // total()*elemSize() bytes straight from the ROI origin. For a 512-wide
      // window on a 2100-wide canvas that is 125 parent rows chopped into
      // 512-px strips, sweeping across each row four times -- a scrambled
      // image, not the patch. The trade-off curve was measured on that, which
      // is why its rms barely moved when the frames were visibly sharper.
      //
      // copyTo materialises a continuous Mat; `.data` is then safe. ucharPtr
      // also respects stride if a Mat op is not wanted. Never read `.data`
      // from a roi, and note that clone() does NOT help -- it is correct for
      // OpenCV operations but still reports the parent stride.
      const roi = warped.roi(new cv.Rect(x0, y0, s, s));
      const patch = new cv.Mat();
      roi.copyTo(patch);
      roi.delete();
      const buf = patch.data;
      for (let k = 0; k < FRACTIONS.length; k++) {
        if (rankFrac > FRACTIONS[k]) continue;   // this frame is not in the best f
        const set = curve.sets[k];
        const half = seq % 2 ? set.odd : set.even;
        for (let i = 0; i < buf.length; i++) { set.sum[i] += buf[i]; half[i] += buf[i]; }
        set.n++;
        if (seq % 2) set.nOdd++; else set.nEven++;
      }
      patch.delete();
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
      fillNaN, densify, ramps, subpixel, correlate, lcg,
      newAccumulator, accumulate, finishAcc, render, cellQuality, cellWeights, densifyWeights,
      innerMask, reliability, stackNoise, frameNoise, preview, halfMean, mat32F, releaseScratch,
      edgeProfile, psfFromProfile, richardsonLucy, bilinear, buildSupport, measureRinging,
      waveletSharpen,
      discGeometry, fitLimb, fitInnerLimb, fitCircleLS, circumcircle, coarseCentre, coverageOf,
      FRACTIONS, frameQuality, newCurve, accumulateCurve, curveResult,
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createPipeline };
  else root.createPipeline = createPipeline;
})(typeof self !== 'undefined' ? self : globalThis);
