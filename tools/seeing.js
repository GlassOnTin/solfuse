// An atmospheric seeing model matched to this footage, so tests can be run
// against synthetic frames whose distortion is known exactly.
//
// WHY THIS EXISTS
//
// Every claim SolFuse makes about alignment is a claim about atmospheric
// distortion, and until now the tests only ever applied a uniform shift. A
// uniform shift is the one case multi-point alignment is not for. This model
// produces the thing multi-point alignment actually corrects -- a smoothly
// varying displacement field across the field of view -- together with the
// ground truth for it.
//
// THE OPTICAL SETUP, derived from the footage rather than assumed
//
//   fitted solar radius     931.7 px      (measured on C0013 frame 0)
//   solar diameter          1919 arcsec
//   => pixel scale          1.03 arcsec/px
//   sensor pitch            3.44 um       (1-inch sensor, 13.2 mm, full-width 4K)
//   => focal length         689 mm
//   f-number                f/11          (stated)
//   => aperture D           62.6 mm
//   frame rate              25 fps        (ffprobe) -> 40 ms between frames
//   ISO                     800           (stated)
//   ND                      20 stops      (stated)
//
// The focal length follows from the pixel scale and an assumed sensor pitch; if
// the capture was cropped or a converter was used, D scales with it. D is the
// parameter that matters, so treat it as +/- 30% rather than exact.
//
// EXPOSURE, and a correction to what the README used to say
//
// Solar disc luminance is about 1.6e9 cd/m2 at ground level. Through 20 stops
// that is 1.5e3 cd/m2, and at ISO 800 the correct exposure at f/11 is
//
//   t = N^2 * K / (L * S) = 121 * 12.5 / (1524 * 800) = 1.2 ms
//
// So the ND filter does *not* force a long exposure. At 1.2 ms the shutter is
// shorter than any plausible atmospheric coherence time and the seeing is
// frozen within each frame, not averaged. The README's stated reason for lucky
// imaging failing on this footage was wrong.
//
// THE REAL REASON, and it is a much better one
//
// Lucky imaging pays when the aperture is large compared with the Fried
// parameter, because then the instantaneous wavefront error is large and varies
// a lot from frame to frame. Noll gives the residual wavefront variance after
// tip and tilt are removed:
//
//   sigma^2 = 0.134 (D/r0)^(5/3)  rad^2
//
// At D = 62.6 mm and r0 = 5 cm, D/r0 = 1.25 and sigma^2 = 0.19 rad^2, a Strehl
// ratio of 0.82. The frames are already near diffraction-limited and there is
// almost nothing left for frame selection to choose between. What the
// atmosphere mostly does at this aperture is *move* the image -- tip and tilt
// carry 87% of the total wavefront variance -- and alignment removes that.
//
// Selection would start to pay near D/r0 > 3, which at r0 = 5 cm means an
// aperture above 15 cm. The model can be run at both, which is the point.

'use strict';

const ARCSEC = Math.PI / (180 * 3600);

// Measured and stated parameters for this footage, in one place.
const FOOTAGE = {
  pixelScale: 1.03,        // arcsec/px, from the fitted solar radius
  focalLength: 0.689,      // m
  fNumber: 11,
  aperture: 0.689 / 11,    // m
  lambda: 550e-9,          // m
  fps: 25,
  exposure: 1.2e-3,        // s, computed above
  iso: 800,
  ndStops: 20,
  solarRadiusPx: 931.7,
};

function createSeeing(cv, opt = {}) {
  const o = Object.assign({
    D: FOOTAGE.aperture,
    r0: 0.05,              // Fried parameter at 550 nm, m. Daytime solar: 3-10 cm.
    lambda: FOOTAGE.lambda,
    pixelScale: FOOTAGE.pixelScale,   // arcsec/px
    // Isoplanatic angle, arcsec. Daytime solar seeing is dominated by the
    // ground layer -- sun-heated ground stirring the first tens of metres --
    // not by the high layers that set the 2-4 arcsec figure quoted for
    // nighttime astronomy. That distinction decides whether multi-point
    // alignment can work at all: at 3 arcsec the layer sits at 1.1 km, tilt
    // decorrelates over 12 px, and an 80 px alignment patch averages seven
    // independent cells into mush. At 20 arcsec the layer is at 160 m, tilt
    // stays coherent over ~77 px, and a 100 px grid can track it -- which is
    // what the footage actually shows.
    theta0: 20.0,
    wind: 10,              // m/s, sets the coherence time
    exposure: FOOTAGE.exposure,
    subSteps: 1,           // sub-exposures integrated per frame
    grid: 9,               // field points across, where tilt is evaluated
    blurGrid: 3,           // field points across, where the PSF is evaluated
    seed: 1,
  }, opt);

  const Dr0 = o.D / o.r0;
  // Noll: residual wavefront variance once tip and tilt are gone.
  const residualVar = 0.134 * Math.pow(Dr0, 5 / 3);
  const strehl = Math.exp(-residualVar);
  // One-axis image motion from Zernike tilt, in arcsec then pixels.
  const tiltRmsArcsec = 0.427 * Math.pow(Dr0, 5 / 6) * (o.lambda / o.D) / ARCSEC;
  const tiltRmsPx = tiltRmsArcsec / o.pixelScale;
  // Single layer placed to give the requested isoplanatic angle, and the
  // coherence time that the wind then implies.
  const layerHeight = 0.314 * o.r0 / (o.theta0 * ARCSEC);
  // Angle over which image *motion* stays correlated. Tilt averages over the
  // aperture, so it decorrelates when the beam footprints separate by about D,
  // which is a much wider angle than the full-wavefront isoplanatic patch.
  const tiltAngleArcsec = (o.D / layerHeight) / ARCSEC;
  const tau0 = 0.31 * o.r0 / o.wind;

  const info = {
    Dr0, residualVar, strehl, tiltRmsArcsec, tiltRmsPx, layerHeight, tau0,
    diffractionPx: (o.lambda / o.D) / ARCSEC / o.pixelScale,
    seeingFwhmPx: (0.98 * o.lambda / o.r0) / ARCSEC / o.pixelScale,
    tiltAngleArcsec,
    tiltCoherencePx: tiltAngleArcsec / o.pixelScale,
    exposuresPerTau0: o.exposure / tau0,
    framesPerTau0: (1 / FOOTAGE.fps) / tau0,
  };

  // ---- random fields ------------------------------------------------------

  function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
  function gauss(r) {
    const u = Math.max(1e-12, r()), v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // A smooth 2D random field on the layer, in metres. Frozen flow means the
  // same field is read at an offset that grows with time, so temporal and
  // angular decorrelation come from one mechanism, as they do in the air.
  function smoothField(N, corrPx, seed) {
    const r = rng(seed);
    const raw = new Float32Array(N * N);
    for (let i = 0; i < raw.length; i++) raw[i] = gauss(r);
    const m = new cv.Mat(N, N, cv.CV_32F);
    m.data32F.set(raw);
    const b = new cv.Mat();
    cv.GaussianBlur(m, b, new cv.Size(0, 0), corrPx);
    // Smoothing kills the variance; restore it so the field has unit rms.
    let s = 0, s2 = 0;
    const d = b.data32F;
    for (let i = 0; i < d.length; i++) { s += d[i]; s2 += d[i] * d[i]; }
    const mu = s / d.length;
    const sd = Math.sqrt(Math.max(1e-12, s2 / d.length - mu * mu));
    for (let i = 0; i < d.length; i++) d[i] = (d[i] - mu) / sd;
    m.delete();
    return b;
  }

  // Layer sampling. One screen pixel is a fixed number of metres; a field angle
  // maps to a position on the layer through the layer height, and time maps to
  // a position through the wind.
  const metresPerScreenPx = o.D / 2;                     // half an aperture per cell
  const SCREEN = 512;

  // Tip and tilt decorrelate over roughly an aperture; the higher-order modes
  // decorrelate over the same distance, so one correlation length serves both.
  const corrPx = Math.max(1.5, o.D / metresPerScreenPx);

  const fields = {
    tipX: smoothField(SCREEN, corrPx, o.seed * 7 + 1),
    tipY: smoothField(SCREEN, corrPx, o.seed * 7 + 2),
    modes: [],
  };
  const NMODES = 18;                                      // Zernike j = 4..21
  for (let k = 0; k < NMODES; k++) {
    fields.modes.push(smoothField(SCREEN, corrPx, o.seed * 7 + 10 + k));
  }

  // Noll cumulative residuals, Delta_J in units of (D/r0)^(5/3). The variance
  // of mode j is Delta_{j-1} - Delta_j.
  const NOLL = [1.0299, 0.582, 0.134, 0.111, 0.0880, 0.0648, 0.0587, 0.0525,
                0.0463, 0.0401, 0.0377, 0.0352, 0.0328, 0.0304, 0.0279, 0.0267,
                0.0255, 0.0243, 0.0232, 0.0220, 0.0208];
  const modeVar = [];
  for (let j = 4; j <= 21; j++) {
    modeVar.push(Math.max(0, (NOLL[j - 2] - NOLL[j - 1])) * Math.pow(Dr0, 5 / 3));
  }

  function sampleField(f, ax, ay, t) {
    // ax, ay are field angles in arcsec; t in seconds.
    const px = (ax * ARCSEC * layerHeight + o.wind * t) / metresPerScreenPx;
    const py = (ay * ARCSEC * layerHeight) / metresPerScreenPx;
    const x = ((px % SCREEN) + SCREEN) % SCREEN;
    const y = ((py % SCREEN) + SCREEN) % SCREEN;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const x1 = (x0 + 1) % SCREEN, y1 = (y0 + 1) % SCREEN;
    const d = f.data32F;
    return d[y0 * SCREEN + x0] * (1 - fx) * (1 - fy) + d[y0 * SCREEN + x1] * fx * (1 - fy)
         + d[y1 * SCREEN + x0] * (1 - fx) * fy + d[y1 * SCREEN + x1] * fx * fy;
  }

  // ---- Zernike pupil and the instantaneous PSF ----------------------------

  // Noll-ordered Zernike polynomials, j = 4..21, on the unit disc.
  function zernike(j, rho, th) {
    const r2 = rho * rho, r3 = r2 * rho, r4 = r2 * r2, r5 = r4 * rho;
    switch (j) {
      case 4: return Math.sqrt(3) * (2 * r2 - 1);
      case 5: return Math.sqrt(6) * r2 * Math.sin(2 * th);
      case 6: return Math.sqrt(6) * r2 * Math.cos(2 * th);
      case 7: return Math.sqrt(8) * (3 * r3 - 2 * rho) * Math.sin(th);
      case 8: return Math.sqrt(8) * (3 * r3 - 2 * rho) * Math.cos(th);
      case 9: return Math.sqrt(8) * r3 * Math.sin(3 * th);
      case 10: return Math.sqrt(8) * r3 * Math.cos(3 * th);
      case 11: return Math.sqrt(5) * (6 * r4 - 6 * r2 + 1);
      case 12: return Math.sqrt(10) * (4 * r4 - 3 * r2) * Math.cos(2 * th);
      case 13: return Math.sqrt(10) * (4 * r4 - 3 * r2) * Math.sin(2 * th);
      case 14: return Math.sqrt(10) * r4 * Math.cos(4 * th);
      case 15: return Math.sqrt(10) * r4 * Math.sin(4 * th);
      case 16: return Math.sqrt(12) * (10 * r5 - 12 * r3 + 3 * rho) * Math.cos(th);
      case 17: return Math.sqrt(12) * (10 * r5 - 12 * r3 + 3 * rho) * Math.sin(th);
      case 18: return Math.sqrt(12) * (5 * r5 - 4 * r3) * Math.cos(3 * th);
      case 19: return Math.sqrt(12) * (5 * r5 - 4 * r3) * Math.sin(3 * th);
      case 20: return Math.sqrt(12) * r5 * Math.cos(5 * th);
      case 21: return Math.sqrt(12) * r5 * Math.sin(5 * th);
      default: return 0;
    }
  }

  // Pupil sampling chosen so the FFT output lands on the image pixel scale:
  // one output pixel is lambda / (Npup * dx), so Npup / Dpx = lambda / (D * ps).
  const psRad = o.pixelScale * ARCSEC;
  const DPX = 32;
  const NPUP = Math.max(32, 2 * Math.round(DPX * o.lambda / (o.D * psRad) / 2));
  const pupilCache = { rho: null, th: null, mask: null };
  function pupilGeom() {
    if (pupilCache.rho) return pupilCache;
    const rho = new Float32Array(NPUP * NPUP);
    const th = new Float32Array(NPUP * NPUP);
    const mask = new Uint8Array(NPUP * NPUP);
    const c = NPUP / 2;
    for (let y = 0; y < NPUP; y++) {
      for (let x = 0; x < NPUP; x++) {
        const dx = (x - c) / (DPX / 2), dy = (y - c) / (DPX / 2);
        const r = Math.hypot(dx, dy);
        const i = y * NPUP + x;
        rho[i] = r; th[i] = Math.atan2(dy, dx); mask[i] = r <= 1 ? 1 : 0;
      }
    }
    Object.assign(pupilCache, { rho, th, mask });
    return pupilCache;
  }

  // |FFT(pupil * exp(i phi))|^2, centred, normalised to sum 1.
  function psfFrom(coeffs) {
    const { rho, th, mask } = pupilGeom();
    const re = new Float32Array(NPUP * NPUP);
    const im = new Float32Array(NPUP * NPUP);
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      let phi = 0;
      for (let k = 0; k < coeffs.length; k++) {
        if (coeffs[k] === 0) continue;
        phi += coeffs[k] * zernike(k + 4, rho[i], th[i]);
      }
      re[i] = Math.cos(phi); im[i] = Math.sin(phi);
    }
    const mre = new cv.Mat(NPUP, NPUP, cv.CV_32F); mre.data32F.set(re);
    const mim = new cv.Mat(NPUP, NPUP, cv.CV_32F); mim.data32F.set(im);
    const planes = new cv.MatVector();
    planes.push_back(mre); planes.push_back(mim);
    const cplx = new cv.Mat();
    cv.merge(planes, cplx);
    cv.dft(cplx, cplx, cv.DFT_COMPLEX_OUTPUT, 0);
    const out = new cv.MatVector();
    cv.split(cplx, out);
    const R = out.get(0).data32F, I = out.get(1).data32F;
    // fftshift, so the PSF core sits at the centre of the kernel.
    const half = NPUP / 2;
    const psf = new Float32Array(NPUP * NPUP);
    let sum = 0;
    for (let y = 0; y < NPUP; y++) {
      for (let x = 0; x < NPUP; x++) {
        const sy = (y + half) % NPUP, sx = (x + half) % NPUP;
        const i = sy * NPUP + sx, j = y * NPUP + x;
        const v = R[i] * R[i] + I[i] * I[i];
        psf[j] = v; sum += v;
      }
    }
    for (let i = 0; i < psf.length; i++) psf[i] /= sum;
    mre.delete(); mim.delete(); cplx.delete();
    planes.delete(); out.get(0).delete(); out.get(1).delete(); out.delete();
    return psf;
  }

  // Trim to an odd kernel holding most of the energy, so filter2D stays cheap.
  function trimPSF(psf, keep = 0.97) {
    const c = NPUP / 2;
    let best = 3;
    for (let h = 2; h < c - 1; h++) {
      let s = 0;
      for (let y = c - h; y <= c + h; y++) {
        for (let x = c - h; x <= c + h; x++) s += psf[y * NPUP + x];
      }
      if (s >= keep) { best = h; break; }
      best = h;
    }
    const k = 2 * best + 1;
    const out = new Float32Array(k * k);
    let s = 0;
    for (let y = 0; y < k; y++) {
      for (let x = 0; x < k; x++) {
        const v = psf[(c - best + y) * NPUP + (c - best + x)];
        out[y * k + x] = v; s += v;
      }
    }
    for (let i = 0; i < out.length; i++) out[i] /= s;
    return { psf: out, k };
  }

  // ---- one frame ----------------------------------------------------------

  // Returns the distorted image plus the ground-truth displacement field on the
  // requested grid, in pixels, expressed as "where this patch moved to".
  function frame(scene, n, t, opts = {}) {
    const G = o.grid;
    const gx = new Float32Array(G * G);
    const gy = new Float32Array(G * G);
    const half = n / 2;
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        // Field angle of this grid point, arcsec from the frame centre.
        const ax = ((i + 0.5) / G * n - half) * o.pixelScale;
        const ay = ((j + 0.5) / G * n - half) * o.pixelScale;
        gx[j * G + i] = sampleField(fields.tipX, ax, ay, t) * tiltRmsPx;
        gy[j * G + i] = sampleField(fields.tipY, ax, ay, t) * tiltRmsPx;
      }
    }

    // Warp the scene by the tilt field. remap needs absolute source
    // coordinates, so the map is identity minus the displacement.
    // noTilt leaves the image where it is, which isolates the blur: it models
    // an alignment stage that worked perfectly, so any remaining frame-to-frame
    // difference is the thing frame selection would have to exploit.
    const src = new cv.Mat(n, n, cv.CV_8U);
    src.data.set(scene);
    const small = new cv.Mat(G, G, cv.CV_32F);
    const mapx = new cv.Mat(), mapy = new cv.Mat();
    small.data32F.set(gx);
    cv.resize(small, mapx, new cv.Size(n, n), 0, 0, cv.INTER_CUBIC);
    small.data32F.set(gy);
    cv.resize(small, mapy, new cv.Size(n, n), 0, 0, cv.INTER_CUBIC);
    for (let y = 0, i = 0; y < n; y++) {
      for (let x = 0; x < n; x++, i++) {
        mapx.data32F[i] = x - mapx.data32F[i];
        mapy.data32F[i] = y - mapy.data32F[i];
      }
    }
    let warped;
    if (opts.noTilt) {
      warped = src.clone();
    } else {
      warped = new cv.Mat();
      cv.remap(src, warped, mapx, mapy, cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar(0));
    }
    src.delete(); small.delete(); mapx.delete(); mapy.delete();

    // Spatially varying blur: one PSF per blur-grid cell, blended by distance.
    // At this aperture the PSF barely varies, which is itself the finding, but
    // the machinery is here so a larger D can be simulated honestly.
    const B = opts.noBlur ? 0 : o.blurGrid;
    let blurred = warped;
    if (B > 0) {
      const acc = new cv.Mat(n, n, cv.CV_32F, new cv.Scalar(0));
      const wsum = new cv.Mat(n, n, cv.CV_32F, new cv.Scalar(0));
      const f32 = new cv.Mat();
      warped.convertTo(f32, cv.CV_32F);
      for (let j = 0; j < B; j++) {
        for (let i = 0; i < B; i++) {
          const ax = ((i + 0.5) / B * n - half) * o.pixelScale;
          const ay = ((j + 0.5) / B * n - half) * o.pixelScale;
          const coeffs = modeVar.map((v, k) =>
            sampleField(fields.modes[k], ax, ay, t) * Math.sqrt(v));
          const { psf, k } = trimPSF(psfFrom(coeffs));
          const kern = new cv.Mat(k, k, cv.CV_32F);
          kern.data32F.set(psf);
          const conv = new cv.Mat();
          cv.filter2D(f32, conv, -1, kern, new cv.Point(-1, -1), 0, cv.BORDER_REPLICATE);
          // Separable bilinear weight for this cell.
          const wm = new cv.Mat(n, n, cv.CV_32F);
          const cx = (i + 0.5) / B * n, cy = (j + 0.5) / B * n, span = n / B;
          for (let y = 0, p = 0; y < n; y++) {
            const wy = Math.max(0, 1 - Math.abs(y - cy) / span);
            for (let x = 0; x < n; x++, p++) {
              wm.data32F[p] = wy * Math.max(0, 1 - Math.abs(x - cx) / span);
            }
          }
          cv.multiply(conv, wm, conv);
          cv.add(acc, conv, acc);
          cv.add(wsum, wm, wsum);
          kern.delete(); conv.delete(); wm.delete();
        }
      }
      cv.divide(acc, wsum, acc);
      const out8 = new cv.Mat();
      acc.convertTo(out8, cv.CV_8U);
      acc.delete(); wsum.delete(); f32.delete();
      if (blurred !== warped) blurred.delete();
      warped.delete();
      blurred = out8;
    }

    return { mat: blurred, gx, gy, grid: G };
  }

  // Integrate several instants to model a finite exposure.
  function exposureFrame(scene, n, t, opts = {}) {
    const steps = Math.max(1, o.subSteps);
    if (steps === 1) return frame(scene, n, t, opts);
    const acc = new cv.Mat(n, n, cv.CV_32F, new cv.Scalar(0));
    let gx = null, gy = null, G = 0;
    for (let s = 0; s < steps; s++) {
      const r = frame(scene, n, t + (s / steps) * o.exposure, opts);
      const f = new cv.Mat();
      r.mat.convertTo(f, cv.CV_32F);
      cv.add(acc, f, acc);
      f.delete(); r.mat.delete();
      if (!gx) { gx = Float32Array.from(r.gx); gy = Float32Array.from(r.gy); G = r.grid; }
      else for (let i = 0; i < gx.length; i++) { gx[i] += r.gx[i]; gy[i] += r.gy[i]; }
    }
    for (let i = 0; i < gx.length; i++) { gx[i] /= steps; gy[i] /= steps; }
    const out = new cv.Mat();
    acc.convertTo(out, cv.CV_8U, 1 / steps);
    acc.delete();
    return { mat: out, gx, gy, grid: G };
  }

  function free() {
    fields.tipX.delete(); fields.tipY.delete();
    for (const m of fields.modes) m.delete();
  }

  return { info, opts: o, frame, exposureFrame, psfFrom, trimPSF, free, FOOTAGE };
}

module.exports = { createSeeing, FOOTAGE, ARCSEC };
