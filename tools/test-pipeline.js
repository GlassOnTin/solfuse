#!/usr/bin/env node
// Unit tests for pipeline.js, against ground truth rather than against itself.
//
// Every bug this project has hit was found by accident: a stack that looked
// wrong, a stat that moved the wrong way, a user reporting 188 dropped frames.
// The common thread is that each was a *numerical* error inside a function
// whose output nobody could check by eye. So these tests are built the other
// way round — construct an input whose correct output is known analytically,
// then demand the function produce it.
//
// Where an analytic answer is not available, the test uses an independent and
// deliberately slower computation (brute-force coverage, direct convolution)
// rather than a recorded expected value, so a regression cannot be blessed by
// updating a golden number.
//
//   node tools/test-pipeline.js [--only substring] [--verbose]

const { createPipeline } = require('../pipeline.js');
const { createSeeing, FOOTAGE } = require('./seeing.js');

const args = process.argv.slice(2);
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const VERBOSE = args.includes('--verbose');

let cv, P, O;
const results = [];
let current = null;

function test(name, fn) {
  if (ONLY && !name.toLowerCase().includes(ONLY.toLowerCase())) return;
  current = { name, checks: [], failed: [] };
  try {
    fn();
  } catch (e) {
    current.failed.push(`threw: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
  }
  results.push(current);
  const bad = current.failed.length;
  const mark = bad ? '\x1b[31mFAIL\x1b[0m' : '\x1b[32m ok \x1b[0m';
  console.log(`  ${mark}  ${name}${VERBOSE || bad ? ` (${current.checks.length} checks)` : ''}`);
  for (const f of current.failed) console.log(`          \x1b[31m${f}\x1b[0m`);
  current = null;
}

function ok(cond, msg) {
  current.checks.push(msg);
  if (!cond) current.failed.push(msg);
  return !!cond;
}
function near(got, want, tol, msg) {
  const d = Math.abs(got - want);
  return ok(d <= tol, `${msg}: got ${fmt(got)}, want ${fmt(want)} +/- ${fmt(tol)} (off by ${fmt(d)})`);
}
function fmt(v) {
  if (v === null || v === undefined) return String(v);
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return String(v);
  return Math.abs(v) >= 1000 || (Math.abs(v) < 0.001 && v !== 0) ? v.toExponential(3) : v.toFixed(6);
}

// ---- synthetic scenes, with the answer known by construction ---------------

// A limb-darkened solar disc. Brightness follows a cosine law in the
// normalised radius, which is roughly what a real photosphere does, so the
// limb is a soft edge rather than a step and sub-pixel fits have something
// realistic to bite on.
function disc(w, h, cx, cy, r, opts = {}) {
  const { peak = 200, darkening = 0.6, edge = 1.5, bg = 4 } = opts;
  const g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Index coordinates, not pixel centres: the pipeline reports centres in
      // array indices, and a half-pixel mismatch shows up as a constant bias
      // that looks like a fit error but is only a convention difference.
      const d = Math.hypot(x - cx, y - cy);
      // Soft edge: fraction of the pixel inside the disc, approximated by a
      // smoothstep of width `edge`. Gives sub-pixel information at the limb.
      const t = Math.max(0, Math.min(1, 0.5 - (d - r) / (2 * edge)));
      const s = t * t * (3 - 2 * t);
      let v = bg;
      if (s > 0) {
        const mu = Math.sqrt(Math.max(0, 1 - Math.min(1, (d / r) ** 2)));
        v = bg + peak * (1 - darkening * (1 - mu)) * s;
      }
      g[y * w + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return g;
}

// Totality: a dark lunar disc with a corona falling off as a power law. The
// bright region is an annulus, which is what broke buildAPs and the PSF ladder.
function corona(w, h, cx, cy, rMoon, opts = {}) {
  const { peak = 90, falloff = 2.2, bg = 2, edge = 1.2 } = opts;
  const g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy);
      let v = bg;
      if (d > rMoon) v = bg + peak * Math.pow(rMoon / d, falloff);
      const t = Math.max(0, Math.min(1, 0.5 + (d - rMoon) / (2 * edge)));
      v = bg + (v - bg) * (t * t * (3 - 2 * t));
      g[y * w + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return g;
}

// Deterministic noise, so a failure is reproducible.
function addNoise(g, sigma, seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const out = Uint8Array.from(g);
  for (let i = 0; i < out.length; i++) {
    // Box-Muller, one of the pair is enough here.
    const u = Math.max(1e-9, rnd()), v = rnd();
    const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sigma;
    out[i] = Math.max(0, Math.min(255, Math.round(out[i] + n)));
  }
  return out;
}

// A disc with granulation-like texture, so there is real high-frequency signal
// to lose. A featureless disc has nothing in the fine band but its own limb,
// which makes every sharpness metric look better than it is.
function texturedDisc(n, cx, cy, r, seed) {
  const g = disc(n, n, cx, cy, r);
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
  const f = new Float32Array(n * n);
  for (let i = 0; i < f.length; i++) f[i] = rnd();
  const m = P.mat32F(n, n, f), b = new cv.Mat();
  cv.GaussianBlur(m, b, new cv.Size(0, 0), 1.1);
  const out = Uint8Array.from(g);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (Math.hypot(x - cx, y - cy) >= r * 0.98) continue;
      const i = y * n + x;
      out[i] = Math.max(0, Math.min(255, Math.round(out[i] + b.data32F[i] * 60)));
    }
  }
  m.delete(); b.delete();
  return out;
}

// Physical order: the atmosphere blurs the scene, then the sensor adds noise.
function blurThenNoise(scene, n, sigmaBlur, sigmaNoise, seed) {
  let m = u8mat(scene, n, n);
  if (sigmaBlur > 0) {
    const b = new cv.Mat();
    cv.GaussianBlur(m, b, new cv.Size(0, 0), sigmaBlur);
    m.delete(); m = b;
  }
  if (sigmaNoise > 0) {
    const d = addNoise(new Uint8Array(m.data), sigmaNoise, seed);
    m.delete(); m = u8mat(d, n, n);
  }
  return m;
}

function u8mat(data, w, h) {
  const m = new cv.Mat(h, w, cv.CV_8U);
  m.data.set(data);
  return m;
}

// Shift by a known sub-pixel amount, using OpenCV so the resampling matches
// what the pipeline itself does.
function shifted(data, w, h, dx, dy) {
  const src = u8mat(data, w, h);
  const dst = new cv.Mat();
  const M = cv.matFromArray(2, 3, cv.CV_64F, [1, 0, dx, 0, 1, dy]);
  cv.warpAffine(src, dst, M, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar(0));
  src.delete(); M.delete();
  const out = new Uint8Array(dst.data);
  dst.delete();
  return out;
}

function gaussianPSF(k, sigma) {
  const psf = new Float32Array(k * k);
  const c = (k - 1) / 2;
  let s = 0;
  for (let y = 0; y < k; y++) {
    for (let x = 0; x < k; x++) {
      const v = Math.exp(-((x - c) ** 2 + (y - c) ** 2) / (2 * sigma * sigma));
      psf[y * k + x] = v; s += v;
    }
  }
  for (let i = 0; i < psf.length; i++) psf[i] /= s;
  return psf;
}

function convolve(lin, canvas, psf, k) {
  const img = P.mat32F(canvas, canvas, lin);
  const kern = P.mat32F(k, k, psf);
  const out = new cv.Mat();
  cv.filter2D(img, out, -1, kern, new cv.Point(-1, -1), 0, cv.BORDER_REPLICATE);
  const r = Float32Array.from(out.data32F);
  img.delete(); kern.delete(); out.delete();
  return r;
}

const rms = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - (b ? b[i] : 0); s += d * d; }
  return Math.sqrt(s / a.length);
};

// ---------------------------------------------------------------------------

async function main() {
  cv = await Promise.resolve(require('../vendor/opencv.js'));
  P = createPipeline(cv);
  O = Object.assign({}, P.DEFAULTS);

  console.log('\nSolFuse pipeline tests\n');

  // ---- numerics ----------------------------------------------------------
  console.log('numerics');

  test('mat32F round-trips without boxing', () => {
    const a = new Float32Array([1.5, -2.25, 3e7, 0, 1e-7, 42]);
    const m = P.mat32F(2, 3, a);
    ok(m.rows === 2 && m.cols === 3, `shape 2x3, got ${m.rows}x${m.cols}`);
    for (let i = 0; i < a.length; i++) ok(m.data32F[i] === a[i], `element ${i} exact`);
    m.delete();
  });

  test('bilinear is exact on the lattice and linear between', () => {
    const w = 4, h = 3;
    const img = new Float32Array([0, 10, 20, 30, 100, 110, 120, 130, 200, 210, 220, 230]);
    near(P.bilinear(img, w, h, 1, 1), 110, 1e-6, 'lattice point (1,1)');
    near(P.bilinear(img, w, h, 1.5, 1), 115, 1e-6, 'halfway in x');
    near(P.bilinear(img, w, h, 1, 1.5), 160, 1e-6, 'halfway in y');
    near(P.bilinear(img, w, h, 1.5, 1.5), 165, 1e-6, 'centre of a cell');
    // The clamp must not silently wrap to the far edge.
    near(P.bilinear(img, w, h, -1, 0), P.bilinear(img, w, h, 0, 0) - 10, 1e-6,
         'left of frame extrapolates, does not wrap');
  });

  test('subpixel finds the vertex of a known parabola', () => {
    // y = a(x-p)^2 + c sampled at integers; the fit must return p exactly.
    for (const p of [-0.4, -0.15, 0, 0.2, 0.45]) {
      const cols = 3, rows = 3;
      const d = new Float32Array(cols * rows);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          d[y * cols + x] = -((x - 1 - p) ** 2) - ((y - 1 + p) ** 2);
        }
      }
      const [dx, dy] = P.subpixel(d, cols, rows, 1, 1);
      near(dx, p, 1e-6, `x vertex at ${p}`);
      near(dy, -p, 1e-6, `y vertex at ${-p}`);
    }
    // A flat neighbourhood must give zero, not a divide-by-zero blow-up.
    const flat = new Float32Array(9).fill(5);
    const [fx, fy] = P.subpixel(flat, 3, 3, 1, 1);
    ok(fx === 0 && fy === 0, `flat patch returns 0,0; got ${fx},${fy}`);
  });

  test('toGray matches the stated channel weights', () => {
    const rgba = new Uint8Array([10, 20, 30, 255, 200, 100, 50, 255]);
    const g = P.toGray(rgba, 2, 1, 'green');
    ok(g[0] === 20 && g[1] === 100, `green channel picked, got ${g[0]},${g[1]}`);
    const l = P.toGray(rgba, 2, 1, 'luma');
    // Rec.601 luma, whatever rounding the implementation uses.
    near(l[0], 0.299 * 10 + 0.587 * 20 + 0.114 * 30, 1.5, 'luma pixel 0');
    near(l[1], 0.299 * 200 + 0.587 * 100 + 0.114 * 50, 1.5, 'luma pixel 1');
  });

  // ---- accumulation ------------------------------------------------------
  console.log('\naccumulation and normalisation');

  test('unweighted mean equals the analytic mean', () => {
    const n = 4;
    const acc = P.newAccumulator(n, true);
    const vals = [10, 20, 30, 41];      // mean 25.25, deliberately not an integer
    vals.forEach((v, i) => P.accumulate(acc, new Uint8Array(n * n).fill(v), null, i));
    const mean = P.finishAcc(acc);
    for (let i = 0; i < mean.length; i++) near(mean[i], 25.25, 1e-5, `pixel ${i}`);
    ok(acc.frames === 4, `frame count 4, got ${acc.frames}`);
    ok(acc.nOdd === 2 && acc.nEven === 2, `parity split 2/2, got ${acc.nOdd}/${acc.nEven}`);
  });

  test('weighted mean equals sum(wv)/sum(w), not sum(wv)/n', () => {
    // The exact bug that made seeing weighting look catastrophic: dividing by
    // the frame count instead of the weight sum scales the result by mean(w).
    const n = 2;
    const acc = P.newAccumulator(n, true, true);
    const frames = [{ v: 100, w: 1.0 }, { v: 200, w: 0.5 }, { v: 50, w: 0.25 }];
    let sw = 0, swv = 0;
    frames.forEach((f, i) => {
      P.accumulate(acc, new Uint8Array(n * n).fill(f.v), null, i,
                   new Float32Array(n * n).fill(f.w));
      sw += f.w; swv += f.w * f.v;
    });
    const mean = P.finishAcc(acc);
    for (let i = 0; i < mean.length; i++) near(mean[i], swv / sw, 1e-4, `pixel ${i} weighted mean`);
    // And the halves must normalise the same way.
    for (let i = 0; i < acc.cnt.length; i++) near(acc.cnt[i], sw, 1e-5, `weight sum at ${i}`);
  });

  test('weights on a Uint16 accumulator do not silently truncate', () => {
    // newAccumulator(canvas, halves) allocates Uint16 counts. Passing weights
    // to it does `cnt += 0.75`, which truncates to 0 and quietly discards the
    // frame. Either the count must stay exact or the call must be rejected --
    // silently dropping data is the one outcome that must not happen.
    const n = 2;
    const acc = P.newAccumulator(n, false);          // NOT weighted
    let threw = false;
    try {
      P.accumulate(acc, new Uint8Array(n * n).fill(100), null, 0, new Float32Array(n * n).fill(0.75));
    } catch (e) { threw = true; }
    if (!threw) {
      const mean = P.finishAcc(acc);
      near(mean[0], 100, 1e-3, 'weighted frame on an integer accumulator still averages correctly');
    } else {
      ok(true, 'rejected the unsupported combination instead of truncating');
    }
  });

  test('coverage mask keeps uncovered pixels out of the mean', () => {
    const n = 3;
    const acc = P.newAccumulator(n, true);
    const cover = new Uint8Array(n * n).fill(1);
    cover[4] = 0;                                     // centre pixel never covered
    P.accumulate(acc, new Uint8Array(n * n).fill(80), cover, 0);
    P.accumulate(acc, new Uint8Array(n * n).fill(120), null, 1);   // full coverage
    const mean = P.finishAcc(acc);
    near(mean[0], 100, 1e-5, 'covered pixel averages both frames');
    near(mean[4], 120, 1e-5, 'partially covered pixel uses only the frame that covered it');
    ok(acc.cnt[4] === 1, `count at the uncovered pixel is 1, got ${acc.cnt[4]}`);
  });

  test('a pixel covered by nothing yields 0, not NaN', () => {
    const acc = P.newAccumulator(2, true);
    P.accumulate(acc, new Uint8Array(4).fill(9), new Uint8Array(4).fill(0), 0);
    const mean = P.finishAcc(acc);
    for (let i = 0; i < mean.length; i++) ok(mean[i] === 0, `pixel ${i} is 0, got ${mean[i]}`);
  });

  test('Float32 sum stays exact over a full-length stack', () => {
    // 1140 frames of 255 is the worst case the app can produce. Float32 holds
    // integers exactly to 2^24 = 16.7M; 1140*255 = 290700, so this must be
    // exact, and the test says so rather than assuming it.
    const acc = P.newAccumulator(2, false);
    for (let i = 0; i < 1140; i++) P.accumulate(acc, new Uint8Array(4).fill(255), null, i);
    ok(acc.sum[0] === 290700, `sum exact at 290700, got ${acc.sum[0]}`);
    near(P.finishAcc(acc)[0], 255, 1e-9, 'mean of a constant stack');
  });

  test('odd and even halves partition the frames exactly', () => {
    const acc = P.newAccumulator(2, true);
    for (let i = 0; i < 7; i++) P.accumulate(acc, new Uint8Array(4).fill(i * 10), null, i);
    ok(acc.nOdd + acc.nEven === 7, `halves sum to 7, got ${acc.nOdd}+${acc.nEven}`);
    ok(acc.nOdd === 3 && acc.nEven === 4, `3 odd / 4 even, got ${acc.nOdd}/${acc.nEven}`);
    // Sum of halves must reconstruct the whole, or the split is losing frames.
    near(acc.odd[0] + acc.even[0], acc.sum[0], 1e-4, 'halves reconstruct the total');
    near(acc.cntOdd[0] + acc.cntEven[0], acc.cnt[0], 1e-4, 'half counts reconstruct the total');
  });

  // ---- the displacement field -------------------------------------------
  console.log('\ndisplacement field');

  test('fillNaN leaves measured cells untouched', () => {
    const NG = 7;
    const g = new Float32Array(NG * NG).fill(NaN);
    g[3 * NG + 3] = 2.0;
    g[1 * NG + 1] = -1.0;
    const f = P.fillNaN(g, NG, 2.5);
    near(f[3 * NG + 3], 2.0, 1e-5, 'measured centre cell preserved');
    near(f[1 * NG + 1], -1.0, 1e-5, 'second measured cell preserved');
    ok(Number.isNaN(g[0]), 'input array not mutated');
  });

  test('fillNaN tapers to zero and never invents motion far away', () => {
    // One measurement of 4 px in the middle of an otherwise unmeasured grid.
    // Past the taper distance the correction must be zero: extrapolating it
    // across empty sky produced 0.74 px of invented motion against 0.32 px
    // actually measured.
    const NG = 21, taper = 2.5;
    const g = new Float32Array(NG * NG).fill(NaN);
    g[10 * NG + 10] = 4.0;
    const f = P.fillNaN(g, NG, taper);
    let leaked = 0, maxFar = 0;
    for (let j = 0; j < NG; j++) {
      for (let i = 0; i < NG; i++) {
        const d = Math.hypot(i - 10, j - 10), v = Math.abs(f[j * NG + i]);
        if (Number.isNaN(f[j * NG + i])) leaked++;
        if (d > taper + 1.5) maxFar = Math.max(maxFar, v);
      }
    }
    ok(leaked === 0, `no NaN survives the fill, found ${leaked}`);
    near(maxFar, 0, 1e-3, 'correction is zero beyond the taper');
    ok(Math.abs(f[10 * NG + 11]) < 4.0, 'the neighbour is attenuated, not copied');
  });

  test('fillNaN on an all-unmeasured grid returns all zeros', () => {
    const NG = 5;
    const f = P.fillNaN(new Float32Array(NG * NG).fill(NaN), NG, 2.5);
    for (let i = 0; i < f.length; i++) ok(f[i] === 0, `cell ${i} is 0, got ${f[i]}`);
  });

  test('densify reproduces a linear field at the grid points', () => {
    const NG = 21, canvas = 210, step = canvas / NG;
    const g = new Float32Array(NG * NG);
    for (let j = 0; j < NG; j++) for (let i = 0; i < NG; i++) g[j * NG + i] = 0.1 * i;
    const out = new Float32Array(canvas * canvas);
    const zero = new Float32Array(canvas * canvas);
    P.densify(g, NG, canvas, zero, out);
    // Sample well inside, where the blur and the cubic resize are not edge-affected.
    for (const i of [7, 10, 13]) {
      const px = Math.round((i + 0.5) * step);
      near(out[Math.round(canvas / 2) * canvas + px], 0.1 * i, 0.06, `linear field at cell ${i}`);
    }
  });

  test('densify adds the ramp rather than replacing it', () => {
    const NG = 7, canvas = 70;
    const g = new Float32Array(NG * NG).fill(3);
    const { X } = P.ramps(canvas);
    const out = new Float32Array(canvas * canvas);
    P.densify(g, NG, canvas, X, out);
    const i = 35 * canvas + 35;
    near(out[i], 35 + 3, 0.1, 'map = identity + displacement');
  });

  test('densifyWeights clamps, stays flat on a constant, and neutralises gaps', () => {
    const NG = 7, canvas = 70;
    const flat = new Float32Array(NG * NG).fill(0.5);
    const out = new Float32Array(canvas * canvas);
    P.densifyWeights(flat, NG, canvas, out);
    let lo = Infinity, hi = -Infinity;
    for (const v of out) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    near(lo, 0.5, 1e-3, 'constant weight grid stays constant (low)');
    near(hi, 0.5, 1e-3, 'constant weight grid stays constant (high)');

    // A sharp step is where cubic resampling overshoots; the clamp must hold.
    const step = new Float32Array(NG * NG);
    for (let j = 0; j < NG; j++) for (let i = 0; i < NG; i++) step[j * NG + i] = i < 3 ? 0.05 : 1.0;
    P.densifyWeights(step, NG, canvas, out);
    lo = Infinity; hi = -Infinity;
    for (const v of out) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    ok(lo >= 0.05 - 1e-6, `no undershoot below the floor, got ${lo}`);
    ok(hi <= 1 + 1e-6, `no overshoot above 1, got ${hi}`);

    // Ungraded cells must weight 1 (neutral), never 0 (which would delete them).
    const gaps = new Float32Array(NG * NG).fill(NaN);
    P.densifyWeights(gaps, NG, canvas, out);
    near(out[35 * canvas + 35], 1, 1e-3, 'ungraded region weights 1');
  });

  test('cellWeights applies the exponent, floor and cap correctly', () => {
    const q = new Float32Array([1, 2, 4, 0, NaN, 8, 4, 4, 4]);
    const ref = new Float32Array(9).fill(4);
    const w = P.cellWeights(q, ref, 3, 2, 0.05);
    near(w[0], Math.max(0.05, (1 / 4) ** 2), 1e-6, 'ratio 0.25 squared');
    near(w[1], (2 / 4) ** 2, 1e-6, 'ratio 0.5 squared');
    near(w[2], 1, 1e-6, 'ratio 1 gives weight 1');
    ok(Number.isNaN(w[3]), 'zero quality is NaN, to be neutralised downstream');
    ok(Number.isNaN(w[4]), 'NaN quality stays NaN');
    near(w[5], 1, 1e-6, 'better than reference is capped at 1');
    const wf = P.cellWeights(new Float32Array([0.001]), new Float32Array([4]), 1, 2, 0.2);
    near(wf[0], 0.2, 1e-6, 'floor respected');
  });

  // ---- local quality -----------------------------------------------------
  console.log('\nlocal quality metric');

  test('cellQuality falls as blur rises, at every noise level', () => {
    // The atmosphere blurs and *then* the sensor adds noise, so the test must
    // apply them in that order. Blurring an already-noisy frame suppresses the
    // noise too, which flatters any metric that divides by a noise-dominated
    // band -- that is how the previous metric passed inspection.
    // Cell size must match the real configuration: canvas 2100 at step 100 is a
    // 100 px cell, so 700/7 here. A 30 px cell has too few samples for a stable
    // band-energy estimate and fails for reasons the app never meets.
    const n = 700, NG = 7;
    const scene = texturedDisc(n, n / 2, n / 2, 240, 3);
    // Which cells carry real signal is decided noise-free, once. Ranking blur
    // inside a cell that holds nothing but grain is not something any metric
    // can do, so demanding it would only be a test of the gate.
    const signalCells = [];
    const q0 = P.cellQuality(blurThenNoise(scene, n, 0, 0, 5), n, NG, O);
    for (let i = 0; i < q0.length; i++) if (q0[i] > 0) signalCells.push(i);
    ok(signalCells.length >= 8, `enough signal cells to judge, got ${signalCells.length}`);

    for (const sigma of [0, 1, 2, 4, 8]) {
      const q = [0, 1.0, 2.5].map((b) => P.cellQuality(blurThenNoise(scene, n, b, sigma, 5), n, NG, O));
      let graded = 0, wrong = 0;
      for (const i of signalCells) {
        if (!(q[0][i] > 0) || !(q[1][i] > 0) || !(q[2][i] > 0)) continue;
        graded++;
        if (!(q[0][i] > q[1][i] && q[1][i] > q[2][i])) wrong++;
      }
      ok(graded >= 8, `sigma ${sigma}: enough cells graded, got ${graded}`);
      ok(wrong === 0, `sigma ${sigma}: quality falls with blur in every signal cell, ${wrong}/${graded} wrong`);
    }
  });

  test('cellQuality is invariant to brightness scaling and offset', () => {
    // If it is not, the metric grades exposure instead of sharpness, and the
    // weighting would systematically favour the brighter half of the disc.
    const n = 210, NG = 7;
    const base = addNoise(disc(n, n, n / 2, n / 2, 70, { peak: 100 }), 2, 11);
    const m1 = u8mat(base, n, n);
    const scaled = new cv.Mat();
    m1.convertTo(scaled, cv.CV_8U, 1.8, 0);           // 1.8x brightness
    const shift = new cv.Mat();
    m1.convertTo(shift, cv.CV_8U, 1.0, 25);           // +25 DN pedestal
    const q1 = P.cellQuality(m1, n, NG, O);
    const qs = P.cellQuality(scaled, n, NG, O);
    const qo = P.cellQuality(shift, n, NG, O);
    let n1 = 0, badScale = 0, badOff = 0;
    for (let i = 0; i < q1.length; i++) {
      if (!(q1[i] > 0) || !(qs[i] > 0) || !(qo[i] > 0)) continue;
      n1++;
      if (Math.abs(qs[i] / q1[i] - 1) > 0.15) badScale++;
      if (Math.abs(qo[i] / q1[i] - 1) > 0.15) badOff++;
    }
    ok(n1 >= 8, `enough cells compared, got ${n1}`);
    ok(badScale === 0, `scale-invariant in all cells, ${badScale}/${n1} drifted >15%`);
    ok(badOff === 0, `offset-invariant in all cells, ${badOff}/${n1} drifted >15%`);
    for (const m of [m1, scaled, shift]) m.delete();
  });

  test('frameQuality is monotonic in blur at every noise level', () => {
    // The regression that motivated this whole suite. Real footage measures
    // sigma 1.05 DN between consecutive aligned frames, so the low-noise rows
    // are the ones that matter, not the high-noise row where almost any metric
    // works.
    const n = 800;
    const scene = texturedDisc(n, n / 2, n / 2, 260, 3);
    for (const sigma of [0, 1, 2, 4, 8]) {
      const q = [0, 0.5, 1.0, 2.5].map((b) => {
        const m = blurThenNoise(scene, n, b, sigma, 7);
        const v = P.frameQuality(m, n, 700);
        m.delete();
        return v;
      });
      const mono = q[0] > q[1] && q[1] > q[2] && q[2] > q[3];
      ok(mono, `sigma ${sigma}: strictly decreasing with blur, got ${q.map(fmt).join(' > ')}`);
    }
  });

  test('frameQuality discriminates blur more strongly than noise', () => {
    // It cannot be perfectly noise-blind, so the requirement is a margin: at
    // the footage's own noise level, half a pixel of blur must move the score
    // further than a doubling of noise does. Otherwise the ranking is really
    // sorting frames by codec picture type again.
    const n = 800;
    const scene = texturedDisc(n, n / 2, n / 2, 260, 3);
    const q = (b, sg) => { const m = blurThenNoise(scene, n, b, sg, 7); const v = P.frameQuality(m, n, 700); m.delete(); return v; };
    const base = q(0, 1);
    const dBlur = Math.abs(q(0.5, 1) - base) / base;
    const dNoise = Math.abs(q(0, 2) - base) / base;
    ok(dBlur > dNoise * 2,
       `blur moves the score more than noise: ${(100 * dBlur).toFixed(1)}% for 0.5 px vs ${(100 * dNoise).toFixed(1)}% for 2x noise`);
  });

  // ---- geometry ----------------------------------------------------------
  console.log('\ngeometry');

  test('circumcircle is exact for three points on a known circle', () => {
    const cx = 13.5, cy = -7.25, r = 40;
    const pt = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const [x1, y1] = pt(0.3), [x2, y2] = pt(2.1), [x3, y3] = pt(4.4);
    const c = P.circumcircle(x1, y1, x2, y2, x3, y3);
    near(c.cx, cx, 1e-6, 'centre x');
    near(c.cy, cy, 1e-6, 'centre y');
    near(c.r, r, 1e-6, 'radius');
    ok(!P.circumcircle(0, 0, 1, 1, 2, 2), 'collinear points rejected');
  });

  test('fitLimb recovers a clean solar disc to sub-pixel accuracy', () => {
    const n = 700, cx = 351.7, cy = 344.2, r = 220;
    const g = disc(n, n, cx, cy, r);
    const geom = P.discGeometry(g, n, n, O.discFrac, 1);
    const c = P.fitLimb(geom, { inside: true });
    ok(c, 'a circle was fitted');
    if (c) {
      near(c.cx, cx, 0.15, 'centre x');
      near(c.cy, cy, 0.15, 'centre y');
      // The radius sits ~1.5 px inside the true limb and that is correct
      // behaviour, not error: limb darkening drops the edge to 40% of peak, so
      // a threshold at 45% of peak necessarily cuts inside. Registration uses
      // the centre, so the bias is harmless as long as it is constant -- which
      // the next test checks.
      near(c.r, r, 3.0, 'radius, allowing for the limb-darkening threshold bias');
    }
  });

  test('the fitLimb bias is constant, so it cancels in registration', () => {
    // A fixed offset is invisible to alignment because every frame carries it.
    // A shift-dependent offset would inject motion, which is not.
    const n = 700, cx = 350, cy = 350, r = 220;
    const errs = [];
    for (const [dx, dy] of [[0, 0], [3, -2], [7.5, 4.25], [-6.25, 1.5]]) {
      const c = P.fitLimb(P.discGeometry(disc(n, n, cx + dx, cy + dy, r), n, n, O.discFrac, 1),
                          { inside: true });
      ok(c, `fitted at shift ${dx},${dy}`);
      if (c) errs.push([c.cx - (cx + dx), c.cy - (cy + dy), c.r]);
    }
    if (errs.length === 4) {
      const spread = (k) => Math.max(...errs.map((e) => e[k])) - Math.min(...errs.map((e) => e[k]));
      ok(spread(0) < 0.1, `centre-x bias constant to 0.1 px, spread ${fmt(spread(0))}`);
      ok(spread(1) < 0.1, `centre-y bias constant to 0.1 px, spread ${fmt(spread(1))}`);
      ok(spread(2) < 0.2, `radius stable across shifts, spread ${fmt(spread(2))}`);
    }
  });

  test('fitLimb beats the centroid on a disc clipped by the frame', () => {
    // The case the README claims: with the disc running off the edge, the
    // centroid is hundreds of px out but the limb fit is still right. If this
    // ever stops being true, the 'limb' coarse mode is pointless.
    const n = 700, cx = 300, cy = 350, r = 320;      // left/right heavily clipped
    const g = disc(n, n, cx, cy, r);
    const cent = P.discCentroid(g, n, n, O.discFrac);
    const geom = P.discGeometry(g, n, n, O.discFrac, 1);
    const c = P.fitLimb(geom, { inside: true });
    ok(c, 'a circle was fitted on the clipped disc');
    if (c) {
      const eLimb = Math.hypot(c.cx - cx, c.cy - cy);
      const eCent = Math.hypot(cent.cx - cx, cent.cy - cy);
      ok(eLimb < 3, `limb fit within 3 px, got ${fmt(eLimb)}`);
      ok(eLimb < eCent, `limb (${fmt(eLimb)} px) beats centroid (${fmt(eCent)} px)`);
    }
  });

  test('fitInnerLimb picks the moon, not the outer corona', () => {
    const n = 700, cx = 348.3, cy = 351.6, rMoon = 150;
    const g = corona(n, n, cx, cy, rMoon);
    const geom = P.discGeometry(g, n, n, 0.15, 1);
    // `inside: true` -- the bright side of the lunar limb is outside it, but
    // the fit is over boundary points of the lit region either way.
    const c = P.fitInnerLimb(geom, { inside: true });
    ok(c, 'an inner circle was fitted');
    if (c) {
      near(c.cx, cx, 1.0, 'lunar centre x');
      near(c.cy, cy, 1.0, 'lunar centre y');
      near(c.r, rMoon, 2.0, 'lunar radius, not the corona radius');
      const outer = P.fitLimb(geom, { inside: true });
      ok(outer && outer.r > rMoon * 1.4,
         `the outer fit really is a different, larger circle: r=${outer ? fmt(outer.r) : 'null'}`);
    }
  });

  test('coverageOf matches a brute-force warped mask', () => {
    // Analytic coverage from the inverted affine, checked against actually
    // warping a white frame. Boundary pixels are excluded: warpToCanvas
    // interpolates there, so a hard >127 test disagrees on a one-pixel ring for
    // reasons that say nothing about the analytic mask.
    const w = 320, h = 240, canvas = 300;
    for (const C of [[1, 0, 20, 0, 1, -15], [1, 0, -40, 0, 1, 30], [1, 0, 0, 0, 1, 0]]) {
      const cover = P.coverageOf(C, w, h, canvas);
      const warp = P.warpToCanvas(new Uint8Array(w * h).fill(255), w, h, C, canvas);
      let disagree = 0, judged = 0;
      for (let y = 1; y < canvas - 1; y++) {
        for (let x = 1; x < canvas - 1; x++) {
          const i = y * canvas + x, v = cover[i] ? 1 : 0;
          let uniform = true;
          for (let dy = -1; dy <= 1 && uniform; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if ((cover[i + dy * canvas + dx] ? 1 : 0) !== v) { uniform = false; break; }
            }
          }
          if (!uniform) continue;                       // on the boundary ring
          judged++;
          if ((warp.data[i] > 127 ? 1 : 0) !== v) disagree++;
        }
      }
      const pct = 100 * disagree / judged;
      ok(judged > canvas * canvas * 0.5, `most of the canvas judged for [${C}], got ${judged}`);
      ok(pct < 0.01, `coverage for [${C}] agrees away from the boundary, off by ${pct.toFixed(4)}%`);
      warp.delete();
    }
  });

  // ---- alignment ---------------------------------------------------------
  console.log('\nalignment');

  test('solveGlobal recovers a known translation', () => {
    const n = 700, canvas = 700;
    const o = Object.assign({}, O, { canvas });
    const base = disc(n, n, 350, 350, 200);
    const c0 = P.coarseCentre(base, n, n, o, null);
    const refWarp = P.warpToCanvas(base, n, n, [1, 0, canvas / 2 - c0.cx, 0, 1, canvas / 2 - c0.cy], canvas);
    const refQ = P.quarterNorm(refWarp, o.quarter);
    refWarp.delete();
    for (const [dx, dy] of [[5, -3], [-11, 7], [2.5, 2.5]]) {
      const moved = shifted(base, n, n, dx, dy);
      const g = P.solveGlobal(moved, n, n, refQ, o, null);
      ok(g, `solved for shift ${dx},${dy}`);
      if (g) {
        // C maps source to canvas: a disc at (350+dx) must land at canvas/2.
        const lx = g.C[0] * (350 + dx) + g.C[1] * (350 + dy) + g.C[2];
        const ly = g.C[3] * (350 + dx) + g.C[4] * (350 + dy) + g.C[5];
        near(lx, canvas / 2, 1.5, `shift ${dx},${dy} lands on centre x`);
        near(ly, canvas / 2, 1.5, `shift ${dx},${dy} lands on centre y`);
      }
    }
  });

  test('measureField recovers a known uniform displacement, with the right sign', () => {
    // A sign error here would warp every frame twice as far the wrong way and
    // still produce a plausible-looking stack, so the test checks the field is
    // usable end to end: applying it must reduce the residual against the
    // reference, not increase it.
    const canvas = 700;
    const o = Object.assign({}, O, { canvas, step: 100, half: 40, search: 12 });
    const base = disc(canvas, canvas, 350, 350, 220);
    const ref = u8mat(base, canvas, canvas);
    const { aps, NG } = P.buildAPs(ref, o);
    ok(aps.length > 4, `enough alignment points to test, got ${aps.length}`);

    const dx = 3, dy = -2;
    const moved = u8mat(shifted(base, canvas, canvas, dx, dy), canvas, canvas);
    const f = P.measureField(moved, aps, NG, o);
    ok(f.used > 4, `points located, got ${f.used}`);

    const gx = P.fillNaN(f.gx, NG, 0), gy = P.fillNaN(f.gy, NG, 0);
    let sx = 0, sy = 0, k = 0;
    for (let i = 0; i < gx.length; i++) if (gx[i] || gy[i]) { sx += gx[i]; sy += gy[i]; k++; }
    ok(k > 0, 'field is non-empty');
    const mx = sx / k, my = sy / k;
    // Magnitude must match the shift; sign is verified by the round-trip below.
    near(Math.abs(mx), Math.abs(dx), 0.6, 'field magnitude in x');
    near(Math.abs(my), Math.abs(dy), 0.6, 'field magnitude in y');

    const { X, Y } = P.ramps(canvas);
    const mapx = new Float32Array(canvas * canvas), mapy = new Float32Array(canvas * canvas);
    P.densify(gx, NG, canvas, X, mapx);
    P.densify(gy, NG, canvas, Y, mapy);
    const mX = P.mat32F(canvas, canvas, mapx), mY = P.mat32F(canvas, canvas, mapy);
    const out = new cv.Mat();
    cv.remap(moved, out, mX, mY, cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar(0));

    // Compare over the disc interior only, away from the border replicate.
    const inner = P.innerMask(ref, o, 80);
    let before = 0, after = 0, nn = 0;
    for (let i = 0; i < inner.length; i++) {
      if (!inner[i]) continue;
      before += (moved.data[i] - ref.data[i]) ** 2;
      after += (out.data[i] - ref.data[i]) ** 2;
      nn++;
    }
    before = Math.sqrt(before / nn); after = Math.sqrt(after / nn);
    ok(after < before * 0.6,
       `applying the field cuts the residual: ${fmt(before)} -> ${fmt(after)} DN (sign convention correct)`);
    for (const m of [ref, moved, mX, mY, out]) m.delete();
  });

  test('buildAPs adapts from a bright disc to a faint corona', () => {
    const canvas = 700;
    const o = Object.assign({}, O, { canvas, step: 50, half: 40, search: 12, minAPs: 24 });

    const full = u8mat(disc(canvas, canvas, 350, 350, 240), canvas, canvas);
    const a1 = P.buildAPs(full, o);
    ok(a1.aps.length >= 24, `full disc yields plenty of points, got ${a1.aps.length}`);
    ok(a1.rung && a1.rung.frac === o.discFrac, 'full disc stops at the first rung');

    const tot = u8mat(addNoise(corona(canvas, canvas, 350, 350, 120), 2, 5), canvas, canvas);
    const a2 = P.buildAPs(tot, o);
    ok(a2.aps.length >= 12, `corona yields a workable number of points, got ${a2.aps.length}`);
    ok(a2.rung && a2.rung.frac < o.discFrac, 'corona falls through to a lower rung');

    // Every patch must lie wholly inside the canvas, or the roi in measureField
    // throws mid-stack.
    const m = o.half + o.search;
    let bad = 0;
    for (const a of a2.aps) {
      if (a.x - m < 0 || a.y - m < 0 || a.x + m > canvas || a.y + m > canvas) bad++;
    }
    ok(bad === 0, `all patches inside the canvas, ${bad} out of bounds`);
    full.delete(); tot.delete();
  });

  // ---- atmosphere --------------------------------------------------------
  //
  // Until now every alignment test applied a uniform shift, which is the one
  // case multi-point alignment is not for. These run against tools/seeing.js,
  // a Kolmogorov model matched to this footage: 63 mm aperture at f/11, 1.03
  // arcsec/px, 25 fps. It produces a smoothly varying displacement field and
  // hands back the ground truth for it.
  console.log('\natmospheric distortion (model-generated ground truth)');

  // Interpolate the model's grid truth at an arbitrary pixel.
  const truthAt = (g, G, n, px, py) => {
    const u = Math.max(0, Math.min(G - 1.001, (px / n) * G - 0.5));
    const v = Math.max(0, Math.min(G - 1.001, (py / n) * G - 0.5));
    const i0 = Math.floor(u), j0 = Math.floor(v), fx = u - i0, fy = v - j0;
    return g[j0 * G + i0] * (1 - fx) * (1 - fy) + g[j0 * G + i0 + 1] * fx * (1 - fy)
         + g[(j0 + 1) * G + i0] * (1 - fx) * fy + g[(j0 + 1) * G + i0 + 1] * fx * fy;
  };

  test('the model reproduces the regime this footage was shot in', () => {
    const sky = createSeeing(cv, { r0: 0.05 });
    const i = sky.info;
    // Sanity-check the physics against hand calculation, so a later edit to the
    // model cannot quietly change the regime the other tests assume.
    near(i.Dr0, 62.6 / 50, 0.05, 'D/r0 at r0 = 5 cm');
    near(i.strehl, Math.exp(-0.134 * Math.pow(i.Dr0, 5 / 3)), 1e-6, 'Strehl from the Noll residual');
    ok(i.strehl > 0.7, `near diffraction-limited at this aperture, Strehl ${fmt(i.strehl)}`);
    ok(i.tiltRmsPx > 0.5 && i.tiltRmsPx < 1.5,
       `tilt rms matches the 0.72 px field the harness measures, got ${fmt(i.tiltRmsPx)} px`);
    ok(i.exposuresPerTau0 < 1,
       `a 1.2 ms exposure freezes the seeing rather than averaging it, ${fmt(i.exposuresPerTau0)} coherence times`);
    // A bigger aperture must leave the near-diffraction-limited regime, or the
    // model cannot say anything about when lucky imaging would start to pay.
    const big = createSeeing(cv, { D: 0.30, r0: 0.05 });
    ok(big.info.strehl < 0.2, `a 300 mm aperture is badly aberrated, Strehl ${fmt(big.info.strehl)}`);
    sky.free(); big.free();
  });

  test('measureField recovers a spatially varying field, not just a mean shift', () => {
    // The claim multi-point alignment rests on, tested against truth for the
    // first time. r0 = 3 cm is poor seeing, chosen so the tilt is comfortably
    // above the matcher's own precision.
    const n = 700;
    const o = Object.assign({}, O, { canvas: n, step: 100, half: 40, search: 12 });
    const scene = texturedDisc(n, n / 2, n / 2, 240, 3);
    const sky = createSeeing(cv, { r0: 0.03, grid: 21, seed: 4 });
    const ref = u8mat(scene, n, n);
    const { aps, NG } = P.buildAPs(ref, o);
    ok(aps.length >= 8, `alignment points available, got ${aps.length}`);

    const fr = sky.exposureFrame(scene, n, 0.5, { noBlur: true });
    const f = P.measureField(fr.mat, aps, NG, o);
    ok(f.used >= 8, `points located under seeing, got ${f.used}`);

    const mx = [], tx = [], my = [], ty = [];
    for (const a of aps) {
      const k = a.j * NG + a.i;
      if (Number.isNaN(f.gx[k])) continue;
      mx.push(f.gx[k]); my.push(f.gy[k]);
      // matchTemplate on an 80 px patch reports what that whole patch did, so
      // the fair comparison is truth averaged over the patch, not sampled at
      // its centre. Tilt stays coherent over about 77 px here, so the two
      // differ by enough to matter.
      let sx = 0, sy = 0, cnt = 0;
      for (let dy = -o.half; dy <= o.half; dy += 8) {
        for (let dx = -o.half; dx <= o.half; dx += 8) {
          sx += truthAt(fr.gx, fr.grid, n, a.x + dx, a.y + dy);
          sy += truthAt(fr.gy, fr.grid, n, a.x + dx, a.y + dy);
          cnt++;
        }
      }
      tx.push(sx / cnt); ty.push(sy / cnt);
    }
    ok(mx.length >= 8, `paired measurements, got ${mx.length}`);

    const corr = (u, v) => {
      const mu = u.reduce((s2, q) => s2 + q, 0) / u.length;
      const mv = v.reduce((s2, q) => s2 + q, 0) / v.length;
      let a2 = 0, b2 = 0, ab = 0;
      for (let i2 = 0; i2 < u.length; i2++) {
        const du = u[i2] - mu, dv = v[i2] - mv;
        a2 += du * du; b2 += dv * dv; ab += du * dv;
      }
      return ab / Math.sqrt(a2 * b2);
    };
    const rx = corr(mx, tx), ry = corr(my, ty);
    ok(Math.abs(rx) > 0.85, `x field tracks truth, r = ${fmt(rx)}`);
    ok(Math.abs(ry) > 0.85, `y field tracks truth, r = ${fmt(ry)}`);

    // Sign and scale together: a slope of -1 is as correct as +1 provided the
    // pipeline applies it consistently, which the round-trip test pins down.
    const slope = (u, v) => {
      let num = 0, den = 0;
      for (let i2 = 0; i2 < u.length; i2++) { num += u[i2] * v[i2]; den += v[i2] * v[i2]; }
      return num / den;
    };
    near(Math.abs(slope(mx, tx)), 1, 0.35, 'x field has unit gain against truth');
    near(Math.abs(slope(my, ty)), 1, 0.35, 'y field has unit gain against truth');

    fr.mat.delete(); ref.delete(); sky.free();
  });

  test('multi-point alignment beats global alignment against ground truth', () => {
    // Stack the same frames two ways and compare each with the undistorted
    // scene. Split-half reliability cannot do this -- it says how reproducible
    // a stack is, not how close to correct.
    const n = 700, K = 10;
    const o = Object.assign({}, O, { canvas: n, step: 100, half: 40, search: 12 });
    const scene = texturedDisc(n, n / 2, n / 2, 240, 3);
    const ref = u8mat(scene, n, n);
    const { aps, NG } = P.buildAPs(ref, o);
    const sky = createSeeing(cv, { r0: 0.03, grid: 15, seed: 9 });
    const { X, Y } = P.ramps(n);
    const mapx = new Float32Array(n * n), mapy = new Float32Array(n * n);

    const accG = P.newAccumulator(n, false);
    const accM = P.newAccumulator(n, false);
    for (let t = 0; t < K; t++) {
      const fr = sky.exposureFrame(scene, n, t * 0.04, { noBlur: true });
      P.accumulate(accG, fr.mat.data, null, t);
      const f = P.measureField(fr.mat, aps, NG, o);
      const gx = P.fillNaN(f.gx, NG, o.taper), gy = P.fillNaN(f.gy, NG, o.taper);
      P.densify(gx, NG, n, X, mapx);
      P.densify(gy, NG, n, Y, mapy);
      const mX = P.mat32F(n, n, mapx), mY = P.mat32F(n, n, mapy);
      const out = new cv.Mat();
      cv.remap(fr.mat, out, mX, mY, cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar(0));
      P.accumulate(accM, out.data, null, t);
      mX.delete(); mY.delete(); out.delete(); fr.mat.delete();
    }
    const globalMean = P.finishAcc(accG);
    const multiMean = P.finishAcc(accM);

    // Judge over the disc interior: the frame edge is border-replicated and the
    // limb is where any resampling shows worst.
    const mask = P.innerMask(ref, o, 100);
    const err = (a2) => {
      let s2 = 0, m = 0;
      for (let i = 0; i < a2.length; i++) if (mask[i]) { const d = a2[i] - scene[i]; s2 += d * d; m++; }
      return Math.sqrt(s2 / m);
    };
    const eG = err(globalMean), eM = err(multiMean);
    ok(eM < eG, `multi-point is closer to truth: ${fmt(eG)} -> ${fmt(eM)} DN rms`);
    ok(eM < eG * 0.95, `and by a worthwhile margin, ${(100 * (1 - eM / eG)).toFixed(1)}% better`);
    ref.delete(); sky.free();
  });

  // ---- deconvolution -----------------------------------------------------
  console.log('\ndeconvolution');

  test('waveletSharpen reconstructs exactly at unit gains', () => {
    const canvas = 128;
    const lin = Float32Array.from(disc(canvas, canvas, 64, 64, 40));
    const out = P.waveletSharpen(lin, canvas, [1, 1, 1]);
    near(rms(out, lin), 0, 1e-3, 'unit gains are the identity');
  });

  test('waveletSharpen amplifies detail without shifting the mean', () => {
    const canvas = 128;
    const lin = Float32Array.from(addNoise(disc(canvas, canvas, 64, 64, 40), 3, 9));
    const out = P.waveletSharpen(lin, canvas, [2.0, 1, 1]);
    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    near(mean(out), mean(lin), 0.5, 'sharpening preserves the mean brightness');
    ok(rms(out, lin) > 0.5, 'sharpening actually changed something');
  });

  test('Richardson-Lucy is a fixed point when the PSF is a delta', () => {
    const canvas = 128, k = 5;
    const psf = new Float32Array(k * k); psf[2 * k + 2] = 1;
    const lin = Float32Array.from(disc(canvas, canvas, 64, 64, 40));
    const out = P.richardsonLucy(lin, canvas, psf, k, 3, {});
    near(rms(out, lin), 0, 0.5, 'a delta PSF leaves the image alone');
  });

  test('Richardson-Lucy recovers a known blur better than not deconvolving', () => {
    // Ground truth, not split-half: the artefacts of deconvolution are
    // deterministic, so both halves of a split share them and split-half is
    // blind to exactly the error that matters here.
    const canvas = 192, k = 11, sigma = 1.6;
    const truth = Float32Array.from(disc(canvas, canvas, 96, 96, 60));
    const psf = gaussianPSF(k, sigma);
    const blurred = convolve(truth, canvas, psf, k);
    const eBlur = rms(blurred, truth);
    let best = Infinity, bestIter = 0;
    for (const iters of [1, 2, 3, 4]) {
      const out = P.richardsonLucy(blurred, canvas, psf, k, iters, {});
      const e = rms(out, truth);
      if (e < best) { best = e; bestIter = iters; }
      for (let i = 0; i < out.length; i++) {
        if (!Number.isFinite(out[i])) { ok(false, `iter ${iters} produced a non-finite pixel`); break; }
      }
    }
    ok(best < eBlur, `deconvolution beats the blurred input: ${fmt(eBlur)} -> ${fmt(best)} DN at ${bestIter} iterations`);
    ok(bestIter <= 4, `the useful range really is small, best at ${bestIter}`);
  });

  test('Richardson-Lucy stays bounded on a dark sky', () => {
    // Dividing by a blurred estimate that tends to zero is what made this
    // diverge to hundreds of DN. Mostly-black input is the adversarial case.
    const canvas = 128, k = 9;
    const lin = new Float32Array(canvas * canvas).fill(0.2);
    for (let y = 60; y < 68; y++) for (let x = 60; x < 68; x++) lin[y * canvas + x] = 240;
    const out = P.richardsonLucy(lin, canvas, gaussianPSF(k, 1.5), k, 4, {});
    let mx = -Infinity, mn = Infinity, bad = 0;
    for (const v of out) {
      if (!Number.isFinite(v)) bad++;
      mx = Math.max(mx, v); mn = Math.min(mn, v);
    }
    ok(bad === 0, `no non-finite pixels, found ${bad}`);
    ok(mn >= -1e-3, `no negative pixels, min ${fmt(mn)}`);
    ok(mx < 400, `no runaway overshoot, max ${fmt(mx)}`);
  });

  test('psfFromProfile recovers the width of a known Gaussian blur', () => {
    // Blur a synthetic disc by a known sigma, measure the limb, reconstruct the
    // PSF, and compare widths. This is the only end-to-end check that the MTF
    // rotation and the enclosed-energy trim are self-consistent.
    //
    // Width is read as FWHM, not as a second moment. The reconstruction leaves
    // broad tails at about 1% of peak across the whole kernel, and r^2 weighting
    // makes those tails dominate: the second moment reads sigma 5.2 for a true
    // sigma of 2 while the core is the right size. That is a property of the
    // estimator, not of the PSF.
    const n = 700, cx = 350, cy = 350, r = 230;
    const scene = disc(n, n, cx, cy, r, { edge: 0.8 });
    const widths = [];
    for (const sigma of [1, 2, 3]) {
      const m = blurThenNoise(scene, n, sigma, 0, 3);
      const img = new Uint8Array(m.data);
      m.delete();
      const circle = P.fitLimb(P.discGeometry(img, n, n, O.discFrac, 1), { inside: true });
      if (!ok(circle, `limb fitted at sigma ${sigma}`)) continue;
      const prof = P.edgeProfile(img, n, n, circle, -1, { span: 18 });
      if (!ok(prof, `edge profile measured at sigma ${sigma}`)) continue;
      const res = P.psfFromProfile(prof, {});
      if (!ok(res && res.psf, `PSF reconstructed at sigma ${sigma}`)) continue;

      const k = res.k, c = Math.round((k - 1) / 2);
      let sum = 0;
      for (const v of res.psf) sum += v;
      near(sum, 1, 0.02, `PSF at sigma ${sigma} sums to 1`);

      const row = [];
      for (let x = 0; x < k; x++) row.push(res.psf[c * k + x]);
      const pk = Math.max(...row);
      let lo = 0, hi = k - 1;
      for (let x = 0; x < k; x++) if (row[x] >= pk / 2) { lo = x; break; }
      for (let x = k - 1; x >= 0; x--) if (row[x] >= pk / 2) { hi = x; break; }
      const fwhm = hi - lo + 1;
      widths.push(fwhm);
      // Integer pixel quantisation of the half-maximum crossing costs about a
      // pixel, so 1.2 px is as tight as this can honestly be asserted.
      near(fwhm, 2.355 * sigma, 1.2, `FWHM at sigma ${sigma}`);
    }
    ok(widths.length === 3 && widths[0] < widths[1] && widths[1] < widths[2],
       `recovered width increases with blur: ${widths.join(' < ')}`);
  });

  test('a PSF measured from the limb actually improves deconvolution', () => {
    // The test that matters, because it is the whole chain as the app runs it:
    // measure the PSF from the limb of a blurred frame, deconvolve that frame
    // with it, and compare against ground truth. Every earlier deconvolution
    // check used a synthetic PSF handed straight to Richardson-Lucy, which
    // never exercises the measurement.
    //
    // Worth knowing: a reconstructed PSF is not a tidy Gaussian. Even for a
    // sharp limb the core is 1 px wide but broad tails near 1% of peak carry
    // most of the total energy, so a "how concentrated is it" assertion fails
    // while the PSF is perfectly usable. Only the end-to-end result decides it.
    const n = 700, sigma = 2.0;
    const truthScene = texturedDisc(n, 350, 350, 230, 3);
    const blurredMat = blurThenNoise(truthScene, n, sigma, 0, 3);
    const observed = new Uint8Array(blurredMat.data);
    blurredMat.delete();

    const circle = P.fitLimb(P.discGeometry(observed, n, n, O.discFrac, 1), { inside: true });
    ok(circle, 'limb fitted on the blurred frame');
    const prof = circle && P.edgeProfile(observed, n, n, circle, -1, { span: 18 });
    ok(prof, 'edge profile measured');
    const res = prof && P.psfFromProfile(prof, {});
    ok(res && res.psf, 'PSF reconstructed from the measured profile');
    if (!res || !res.psf) return;

    const truth = Float32Array.from(truthScene);
    const obs = Float32Array.from(observed);
    // Judge over the disc interior only: the frame border and the limb itself
    // are where any deconvolution rings worst, and neither is what the user
    // looks at.
    const mask = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (Math.hypot(x - 350, y - 350) < 200) mask[y * n + x] = 1;
      }
    }
    const err = (a2) => {
      let s2 = 0, m = 0;
      for (let i = 0; i < a2.length; i++) if (mask[i]) { const d = a2[i] - truth[i]; s2 += d * d; m++; }
      return Math.sqrt(s2 / m);
    };
    const eObs = err(obs);
    let best = Infinity, bestIter = 0;
    for (const iters of [1, 2, 3]) {
      const out = P.richardsonLucy(obs, n, res.psf, res.k, iters, {});
      const e = err(out);
      if (e < best) { best = e; bestIter = iters; }
    }
    ok(best < eObs,
       `measured PSF improves on the blurred frame: ${fmt(eObs)} -> ${fmt(best)} DN at ${bestIter} iterations`);
  });

  // ---- statistics --------------------------------------------------------
  console.log('\nstatistics');

  test('correlate is 1, -1 and 0 in the cases with known answers', () => {
    const n = 400;
    const a = new Float32Array(n), b = new Float32Array(n), c = new Float32Array(n);
    let s = 1234567;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
    for (let i = 0; i < n; i++) { a[i] = rnd(); b[i] = -a[i]; c[i] = rnd(); }
    const mask = new Uint8Array(n).fill(1);
    near(P.correlate(a, a, mask), 1, 1e-6, 'self-correlation');
    near(P.correlate(a, b, mask), -1, 1e-6, 'anti-correlation');
    ok(Math.abs(P.correlate(a, c, mask)) < 0.15, 'independent series correlate near zero');
    // Correlation must be invariant to scale and offset, or split-half
    // reliability would depend on exposure.
    const scaled = Float32Array.from(a, (v) => v * 7.5 + 33);
    near(P.correlate(a, scaled, mask), 1, 1e-6, 'invariant to scale and offset');
    ok(P.correlate(a, c, new Uint8Array(n)) === null, 'an empty mask returns null, not NaN');
  });

  test('lcg is deterministic, so RANSAC fits are reproducible', () => {
    const r1 = P.lcg(42), r2 = P.lcg(42), r3 = P.lcg(43);
    const a = [], b = [], c = [];
    for (let i = 0; i < 8; i++) { a.push(r1()); b.push(r2()); c.push(r3()); }
    ok(a.every((v, i) => v === b[i]), 'same seed gives the same sequence');
    ok(!a.every((v, i) => v === c[i]), 'a different seed gives a different sequence');
    ok(a.every((v) => v >= 0 && v < 1), 'values stay in [0,1)');
  });

  test('accumulateCurve reads the ROI it was asked for, not a strided smear', () => {
    // A submatrix keeps its parent's row stride, and `.data` ignores stride.
    // Reading it gives contiguous bytes from the ROI origin: for a 512-wide
    // window on a 2100-wide canvas, 125 parent rows sliced into strips. The
    // resulting image is scrambled but still looks like plausible data, so
    // nothing downstream complains -- it just stops responding to sharpness.
    const n = 256, s = 64;
    const scene = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) scene[y * n + x] = (y * 7 + x * 3) & 255;
    const m = u8mat(scene, n, n);
    const curve = P.newCurve(s, n / 2, n / 2);
    P.accumulateCurve(curve, m, 1.0, 0);

    const x0 = Math.max(0, Math.min(n - s, (n / 2 - s / 2) | 0));
    const y0 = x0;
    let bad = 0;
    for (let j = 0; j < s; j++) {
      for (let i = 0; i < s; i++) {
        if (curve.sets[curve.sets.length - 1].sum[j * s + i] !== scene[(y0 + j) * n + (x0 + i)]) bad++;
      }
    }
    ok(bad === 0, `every ROI pixel matches the source, ${bad} of ${s * s} wrong`);
    m.delete();
  });

  test('the trade-off curve detects a sharpness difference it should see', () => {
    // Half the frames blurred, half not. A(f) must rank the sharp half above
    // the whole set; if it cannot see a 2 px blur it cannot see seeing either.
    const n = 300, K = 16;
    const scene = texturedDisc(n, n / 2, n / 2, 100, 5);
    const curve = P.newCurve(160, n / 2, n / 2);
    const frames = [];
    for (let i = 0; i < K; i++) frames.push(blurThenNoise(scene, n, i < K / 2 ? 0 : 2.0, 1, 40 + i));
    const q = frames.map((m) => P.frameQuality(m, n, 200));
    const order = q.map((v, i) => [i, v]).sort((a, b) => b[1] - a[1]);
    const rank = new Map();
    order.forEach(([i], k) => rank.set(i, (k + 1) / K));
    const sharpFirst = order.slice(0, K / 2).every(([i]) => i < K / 2);
    ok(sharpFirst, 'the ranking puts the unblurred frames first');
    for (let i = 0; i < K; i++) P.accumulateCurve(curve, frames[i], rank.get(i), i);
    const r = P.curveResult(curve);
    ok(r && r.gainOverAll != null, 'a curve was produced');
    if (r && r.gainOverAll != null) {
      ok(r.gainOverAll > 1.05,
         `selecting the sharp half beats using everything, gain ${fmt(r.gainOverAll)}x at ${(100 * r.bestFraction).toFixed(0)}%`);
    }
    for (const m of frames) m.delete();
  });

  test('curveResult prefers every frame when frames differ only by noise', () => {
    // Identical frames make the curve degenerate -- every keep fraction gives
    // literally the same image, so the peak is arbitrary. Independent noise per
    // frame is the case with a known answer: nothing is gained by discarding
    // frames, so A(f) must peak at f = 1.
    const canvas = 300;
    const curve = P.newCurve(canvas, canvas / 2, canvas / 2);
    const scene = disc(canvas, canvas, 150, 150, 100);
    for (let i = 0; i < 24; i++) {
      const m = u8mat(addNoise(scene, 5, 100 + i * 7), canvas, canvas);
      P.accumulateCurve(curve, m, (i + 1) / 24, i);
      m.delete();
    }
    const r = P.curveResult(curve);
    ok(r && r.points && r.points.length, 'a curve was produced');
    if (r && r.bestFraction != null) {
      ok(r.bestFraction > 0.5,
         `peak at a high keep fraction when frames differ only by noise, got ${fmt(r.bestFraction)}`);
    }
  });

  // ---- colour ------------------------------------------------------------
  console.log('\ncolour');

  test('toPlanes splits into planar RGB with green where the mono path expects it', () => {
    const w = 3, h = 2, n = w * h;
    const rgba = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = 10 + i; rgba[i * 4 + 1] = 50 + i; rgba[i * 4 + 2] = 90 + i; rgba[i * 4 + 3] = 255;
    }
    const p = P.toPlanes(rgba, w, h);
    ok(p.length === n * 3, `planar length ${n * 3}, got ${p.length}`);
    for (let i = 0; i < n; i++) {
      ok(p[i] === 10 + i, `red plane ${i}`);
      ok(p[n + i] === 50 + i, `green plane ${i}`);
      ok(p[2 * n + i] === 90 + i, `blue plane ${i}`);
    }
    // The green plane must be byte-identical to what toGray produces, or colour
    // mode would quietly align on different data from mono mode.
    const g = P.toGray(rgba, w, h, 'green');
    const sub = p.subarray(n, 2 * n);
    let same = true;
    for (let i = 0; i < n; i++) if (g[i] !== sub[i]) same = false;
    ok(same, 'green subarray is identical to toGray(green)');
  });

  test('chroma normalises by the same counts as the green stack', () => {
    const c = 3, n = c * c;
    const acc = P.newAccumulator(c, false);
    const ch = P.newChroma(c);
    const cover = new Uint8Array(n).fill(1);
    cover[4] = 0;                                       // centre never covered
    const frames = [[60, 100, 140], [80, 120, 160]];
    for (let f = 0; f < frames.length; f++) {
      const [r, g, b] = frames[f];
      P.accumulate(acc, new Uint8Array(n).fill(g), f === 0 ? cover : null, f);
      P.accumulateChroma(ch, new Uint8Array(n).fill(r), new Uint8Array(n).fill(b),
                         f === 0 ? cover : null, null);
    }
    const lin = P.finishAcc(acc);
    const col = P.finishChroma(ch, acc.cnt);
    near(lin[0], 110, 1e-4, 'green mean where both frames covered');
    near(col.r[0], 70, 1e-4, 'red mean where both frames covered');
    near(col.b[0], 150, 1e-4, 'blue mean where both frames covered');
    // The partially covered pixel saw only frame 1, and all three channels must
    // agree about that or the colour would shift exactly where coverage changes.
    near(lin[4], 120, 1e-4, 'green at the partially covered pixel');
    near(col.r[4], 80, 1e-4, 'red at the partially covered pixel');
    near(col.b[4], 160, 1e-4, 'blue at the partially covered pixel');
  });

  test('a neutral stack renders grey, and colour mode matches mono there', () => {
    // If R = G = B the composite must be identical to the mono render. This is
    // the guard against colour mode silently tinting a white-light stack.
    const c = 64, n = c * c;
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = 20 + (i % c) * 3;
    const mono = P.render(g, c, {});
    const col = P.renderColour(g, Float32Array.from(g), Float32Array.from(g), c, {});
    let worst = 0;
    for (let i = 0; i < n * 4; i += 4) {
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(col.rgba[i + k] - mono.rgba[i + k]));
    }
    ok(worst <= 1, `neutral input renders identically to mono, worst channel diff ${worst}`);
  });

  test('a red feature comes out red, and saturation scales it', () => {
    // A corona with an H-alpha prominence: neutral everywhere except one patch
    // that is strongly red. That is the case colour mode exists for.
    // Luminance has to vary or the stretch collapses -- render takes lo and hi
    // as percentiles, and a constant frame gives lo == hi and a black result.
    // A flat test scene is not a fair test of a tone curve.
    const c = 96, n = c * c;
    const g = new Float32Array(n), r = new Float32Array(n), b = new Float32Array(n);
    const inPatch = (i) => { const x = i % c, y = (i / c) | 0; return x > 40 && x < 56 && y > 40 && y < 56; };
    for (let i = 0; i < n; i++) {
      const base = 40 + 80 * ((i % c) / c);            // a gradient across the frame
      g[i] = base; r[i] = base; b[i] = base;
      if (inPatch(i)) { r[i] = base * 1.9; b[i] = base * 0.45; }   // H-alpha prominence
    }

    const sats = [0.5, 1, 2].map((saturation) => {
      const out = P.renderColour(g, r, b, c, { saturation, chromaBlur: 1.0 });
      let sr = 0, sb = 0, k = 0, nr = 0, nb = 0, nk = 0;
      for (let i = 0; i < n; i++) {
        const q = i * 4;
        if (inPatch(i)) { sr += out.rgba[q]; sb += out.rgba[q + 2]; k++; }
        else if (i % c > 70 && i % c < 90) { nr += out.rgba[q]; nb += out.rgba[q + 2]; nk++; }
      }
      return { sat: saturation, r: sr / k, b: sb / k, nr: nr / nk, nb: nb / nk };
    });
    for (const s2 of sats) {
      ok(s2.r > s2.b, `saturation ${s2.sat}: the patch is red, R ${s2.r.toFixed(0)} > B ${s2.b.toFixed(0)}`);
      ok(Math.abs(s2.nr - s2.nb) < 6, `saturation ${s2.sat}: neutral area stays neutral`);
    }
    ok(sats[2].r - sats[2].b > sats[0].r - sats[0].b,
       `higher saturation gives more colour: ${(sats[0].r - sats[0].b).toFixed(0)} -> ${(sats[2].r - sats[2].b).toFixed(0)}`);
  });

  test('chroma blur suppresses colour noise without touching luminance detail', () => {
    // The reason for LRGB. Independent noise per channel becomes coloured
    // speckle if the ratios are left sharp; blurring them must remove that
    // while the luminance edge survives, since luminance never sees the blur.
    const c = 128, n = c * c;
    const g = new Float32Array(n), r = new Float32Array(n), b = new Float32Array(n);
    let sd = 99;
    const rnd = () => { sd = (sd * 1664525 + 1013904223) >>> 0; return sd / 4294967296 - 0.5; };
    for (let i = 0; i < n; i++) {
      const base = ((i % c) < c / 2) ? 40 : 160;        // a hard luminance edge
      g[i] = base + rnd() * 14;
      r[i] = base + rnd() * 14;
      b[i] = base + rnd() * 14;
    }
    const spread = (out) => {
      let s2 = 0, k = 0;
      for (let i = 0; i < n; i++) {
        const q = i * 4;
        const mx = Math.max(out.rgba[q], out.rgba[q + 1], out.rgba[q + 2]);
        const mn = Math.min(out.rgba[q], out.rgba[q + 1], out.rgba[q + 2]);
        s2 += mx - mn; k++;
      }
      return s2 / k;
    };
    const sharp = P.renderColour(g, r, b, c, { chromaBlur: 0 });
    const blurred = P.renderColour(g, r, b, c, { chromaBlur: 4 });
    const sSharp = spread(sharp), sBlur = spread(blurred);
    ok(sBlur < sSharp * 0.5,
       `blurring the ratios cuts colour speckle: ${fmt(sSharp)} -> ${fmt(sBlur)} DN channel spread`);
    // Luminance edge must survive untouched: compare against the mono render.
    const mono = P.render(g, c, {});
    let lumErr = 0, k2 = 0;
    for (let i = 0; i < n; i++) {
      const q = i * 4;
      const L = (blurred.rgba[q] + blurred.rgba[q + 1] + blurred.rgba[q + 2]) / 3;
      lumErr += Math.abs(L - mono.rgba[q]); k2++;
    }
    ok(lumErr / k2 < 2, `luminance is unchanged by chroma blur, mean diff ${fmt(lumErr / k2)} DN`);
  });

  test('chroma ratios come from the raw stack, not the sharpened luminance', () => {
    // The luminance is deconvolved and sharpened; red and blue are not. If the
    // ratios were taken against the sharpened green, every edge would gain a
    // colour fringe. chromaG keeps the denominator raw.
    const c = 96, n = c * c;
    const raw = new Float32Array(n), r = new Float32Array(n), b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i % c;
      const base = x < c / 2 ? 50 : 150;               // hard edge, worst case for fringing
      raw[i] = base; r[i] = base; b[i] = base;         // perfectly neutral
    }
    // A "sharpened" luminance: the same edge with overshoot, as deconvolution
    // would leave it.
    const sharp = Float32Array.from(raw);
    for (let i = 0; i < n; i++) {
      const x = i % c;
      if (x === c / 2 - 1) sharp[i] = 20;
      if (x === c / 2) sharp[i] = 190;
    }
    const withRaw = P.renderColour(sharp, r, b, c, { chromaG: raw, chromaBlur: 2 });
    const withoutRaw = P.renderColour(sharp, r, b, c, { chromaBlur: 2 });
    const fringe = (out) => {
      let worst = 0;
      for (let i = 0; i < n; i++) {
        const q = i * 4;
        const mx = Math.max(out.rgba[q], out.rgba[q + 1], out.rgba[q + 2]);
        const mn = Math.min(out.rgba[q], out.rgba[q + 1], out.rgba[q + 2]);
        worst = Math.max(worst, mx - mn);
      }
      return worst;
    };
    const fRaw = fringe(withRaw), fBad = fringe(withoutRaw);
    ok(fRaw <= 2, `a neutral scene stays neutral through a sharpened edge, worst fringe ${fRaw}`);
    ok(fRaw < fBad || fBad <= 2,
       `taking ratios against the raw stack is no worse: ${fBad} -> ${fRaw}`);
  });

  test('colourStrength reports honestly on neutral and coloured input', () => {
    const n = 4096;
    const g = new Float32Array(n).fill(100);
    const neutral = P.colourStrength(g, Float32Array.from(g), Float32Array.from(g), null);
    ok(neutral && neutral.median < 0.01, `a neutral stack reports no colour, got ${neutral ? fmt(neutral.median) : 'null'}`);
    const r = new Float32Array(n).fill(150), b = new Float32Array(n).fill(50);
    const strong = P.colourStrength(g, r, b, null);
    near(strong.median, (150 - 50) / 150, 0.01, 'saturation of a strongly coloured stack');
    // Pixels too dark to have a meaningful colour must be excluded, not counted
    // as neutral -- that would dilute the figure and understate real colour.
    const dark = new Float32Array(n).fill(2);
    ok(P.colourStrength(dark, dark, dark, null) === null, 'an all-dark stack reports nothing rather than zero');

    // The case that caught this out on real footage: a bright neutral subject
    // on a dark sky that carries a small blue pedestal. Saturation is a ratio,
    // so those near-black pixels read as almost fully saturated and swamp the
    // median unless the threshold scales with the image.
    const N2 = 200 * 200;
    const sg = new Float32Array(N2), sr = new Float32Array(N2), sb = new Float32Array(N2);
    for (let i = 0; i < N2; i++) {
      const x = i % 200, y = (i / 200) | 0;
      const onDisc = Math.hypot(x - 100, y - 100) < 40;
      if (onDisc) { sr[i] = 200; sg[i] = 200; sb[i] = 200; }     // neutral subject
      else { sr[i] = 1; sg[i] = 1; sb[i] = 9; }                  // dark sky, blue pedestal
    }
    const cs = P.colourStrength(sg, sr, sb, null);
    ok(cs && cs.median < 0.05,
       `a neutral subject on a blue-tinted dark sky reports little colour, got ${cs ? fmt(cs.median) : 'null'}`);
    ok(cs && cs.fraction < 0.2,
       `and only the lit subject is judged, ${cs ? (100 * cs.fraction).toFixed(1) : '?'}% of pixels`);
  });

  // ---- summary -----------------------------------------------------------
  const failed = results.filter((r) => r.failed.length);
  const checks = results.reduce((s, r) => s + r.checks.length, 0);
  console.log(`\n${results.length - failed.length}/${results.length} tests pass, ${checks} checks\n`);
  if (failed.length) {
    console.log('failing:');
    for (const f of failed) console.log(`  ${f.name}`);
    console.log('');
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
