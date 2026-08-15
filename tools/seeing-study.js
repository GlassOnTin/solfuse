#!/usr/bin/env node
// Does the atmospheric model reproduce the measured result -- that frame
// selection buys nothing on this footage -- and does it say when that would
// change?
//
// Tilt is switched off, which models an alignment stage that worked perfectly.
// Whatever varies between frames after that is exactly what lucky imaging would
// have to exploit, so this isolates the question rather than confounding it
// with alignment.
//
//   node tools/seeing-study.js [--frames N] [--r0 M]

const { createPipeline } = require('../pipeline.js');
const { createSeeing } = require('./seeing.js');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const K = Number(opt('--frames', 32));
const R0 = Number(opt('--r0', 0.05));
const NOISE = Number(opt('--noise', 0));   // sensor noise sigma in DN, added after the blur

(async () => {
  const cv = await Promise.resolve(require('../vendor/opencv.js'));
  const P = createPipeline(cv);
  const n = 512;

  // A textured disc, so there is real fine detail for blur to remove.
  const g = new Uint8Array(n * n);
  let sd = 3;
  const rnd = () => { sd = (sd * 1664525 + 1013904223) >>> 0; return sd / 4294967296 - 0.5; };
  const f = new Float32Array(n * n);
  for (let i = 0; i < f.length; i++) f[i] = rnd();
  const fm = P.mat32F(n, n, f), fb = new cv.Mat();
  cv.GaussianBlur(fm, fb, new cv.Size(0, 0), 1.1);
  const cx = n / 2, cy = n / 2, r = 200;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const t = Math.max(0, Math.min(1, 0.5 - (d - r) / 3));
      const sm = t * t * (3 - 2 * t);
      let v = 4;
      if (sm > 0) {
        const mu = Math.sqrt(Math.max(0, 1 - Math.min(1, (d / r) ** 2)));
        v = 4 + 200 * (1 - 0.6 * (1 - mu)) * sm;
        if (d < r * 0.98) v += fb.data32F[y * n + x] * 60;
      }
      g[y * n + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  fm.delete(); fb.delete();

  console.log(`\natmospheric study: ${K} frames per aperture, r0 = ${(R0 * 100).toFixed(0)} cm, ` +
              `tilt removed so only blur varies, sensor noise sigma ${NOISE} DN\n`);
  console.log('aperture   D/r0  Strehl  sharpness spread   best keep   gain over using all');

  for (const D of [0.0626, 0.10, 0.15, 0.30]) {
    const sky = createSeeing(cv, { D, r0: R0, blurGrid: 1, seed: 11 });
    const frames = [], quality = [];
    for (let t = 0; t < K; t++) {
      const fr = sky.exposureFrame(g, n, t * 0.04, { noTilt: true });
      let m = fr.mat;
      if (NOISE > 0) {
        // Sensor noise goes on after the atmosphere, and it is what makes
        // discarding frames expensive: keeping a quarter of them doubles the
        // noise in the stack, which has to be paid for out of the sharpness
        // that selection buys.
        let sr = (1000 + t * 977) >>> 0;
        const rn = () => { sr = (sr * 1664525 + 1013904223) >>> 0; return sr / 4294967296; };
        const d = new Uint8Array(m.data);
        for (let i = 0; i < d.length; i++) {
          const u = Math.max(1e-9, rn()), v = rn();
          d[i] = Math.max(0, Math.min(255, Math.round(
            d[i] + Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * NOISE)));
        }
        const nm = new cv.Mat(n, n, cv.CV_8U);
        nm.data.set(d);
        m.delete();
        m = nm;
      }
      frames.push(m);
      quality.push(P.frameQuality(m, n, Math.min(400, n)));
    }
    const graded = quality.map((q, i) => [i, q]).sort((a, b) => b[1] - a[1]);
    const rankOf = new Map();
    graded.forEach(([i], k) => rankOf.set(i, (k + 1) / graded.length));
    const curve = P.newCurve(Math.min(400, n), cx, cy);
    for (let t = 0; t < K; t++) P.accumulateCurve(curve, frames[t], rankOf.get(t), t);
    const res = P.curveResult(curve);
    const qs = graded.map(([, q]) => q);
    const spread = 100 * (qs[0] / qs[qs.length - 1] - 1);
    const label = `${(D * 1000).toFixed(0)} mm${Math.abs(D - 0.0626) < 1e-6 ? ' (this)' : ''}`;
    console.log(`${label.padEnd(11)} ${sky.info.Dr0.toFixed(2).padStart(4)}  ` +
                `${sky.info.strehl.toFixed(3).padStart(6)}  ${spread.toFixed(1).padStart(13)}%   ` +
                `${res && res.bestFraction != null ? (100 * res.bestFraction).toFixed(0).padStart(7) + '%' : '      -'}   ` +
                `${res && res.gainOverAll != null ? res.gainOverAll.toFixed(3) + 'x' : '-'}`);
    for (const m of frames) m.delete();
    sky.free();
  }
  console.log('\na gain of 1.000x means stacking everything won, so selection bought nothing\n');
})().catch((e) => { console.error(e); process.exit(1); });
