#!/usr/bin/env node
// Drives the real worker.js under a node worker shim, in mono and in colour,
// over synthetic frames. The pipeline functions are covered by
// tools/test-pipeline.js; this covers the plumbing between them -- unpacking
// planar frames, routing red and blue through the same transform, and choosing
// the right renderer at finish. None of that is reachable from a unit test.
//
//   node tools/smoke-worker.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const REPO = path.join(__dirname, '..');
const guard = require('./strided-guard.js');

const W = 480, H = 360, FRAMES = 8;

function makeSandbox() {
  const posted = [];
  const sandbox = {
    console, Date, Math, JSON, Error, Promise, Array, Object, String, Number, Boolean,
    Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Int16Array, Int32Array,
    Float32Array, Float64Array, Map, Set, isNaN, parseInt, parseFloat, setTimeout, clearTimeout,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.performance = { now: () => Date.now() };
  sandbox.location = { search: '' };   // the worker reads it for the cache-bust suffix
  sandbox.importScripts = (...ps) => {
    for (const p of ps) {
      const clean = p.split('?')[0];
      const mod = require(`${REPO}/${clean}`);
      if (clean.includes('opencv')) sandbox.cv = mod;
      else if (mod && mod.createPipeline) sandbox.createPipeline = mod.createPipeline;
    }
  };
  sandbox.postMessage = (m) => posted.push(m);
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(`${REPO}/worker.js`, 'utf8'), sandbox, { filename: 'worker.js' });
  return { sandbox, posted };
}

// A disc that drifts, with a red patch on one side. Red is the point: a mono
// stack cannot show it, and a broken colour path will show it in the wrong
// place or not at all.
function frame(i, colour) {
  const n = W * H;
  const R = new Uint8Array(n), G = new Uint8Array(n), B = new Uint8Array(n);
  const cx = W / 2 + Math.sin(i * 0.7) * 3, cy = H / 2 + Math.cos(i * 0.9) * 3;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const k = y * W + x;
      if (d > 120) { R[k] = G[k] = B[k] = 3; continue; }
      const mu = Math.sqrt(Math.max(0, 1 - (d / 120) ** 2));
      const v = 30 + 180 * (0.4 + 0.6 * mu) + 12 * Math.sin(x / 5) * Math.cos(y / 6);
      R[k] = G[k] = B[k] = Math.max(0, Math.min(255, v));
      if (x - cx > 60 && Math.abs(y - cy) < 30) {          // the red patch
        R[k] = Math.min(255, v * 1.7);
        B[k] = Math.max(0, v * 0.4);
      }
    }
  }
  if (!colour) return G;
  const out = new Uint8Array(n * 3);
  out.set(R, 0); out.set(G, n); out.set(B, 2 * n);
  return out;
}

(async () => {
  let failures = 0;
  for (const colour of [false, true]) {
    const { sandbox, posted } = makeSandbox();
    let hits = null;
    await Promise.resolve(sandbox.cv).then((cv) => { hits = guard(cv); });
    const send = async (m) => { await sandbox.onmessage({ data: m }); };
    const last = (t) => [...posted].reverse().find((p) => p.type === t);

    await send({ type: 'begin', w: W, h: H,
                 opts: { canvas: 300, multipoint: true, step: 60, search: 8, curve: false, colour } });
    for (let phase = 1; phase <= 2; phase++) {
      for (let i = 0; i < FRAMES; i++) {
        const buf = frame(i, colour);
        const key = colour ? 'planes' : 'gray';
        await send({ type: 'frame', [key]: buf.buffer, index: i, seq: i, phase });
      }
      if (phase === 1) await send({ type: 'buildRef' });
    }
    await send({ type: 'finish', lo: 0.2, hi: 99.9, sharpen: 0, sharpenRadius: 2.4,
                 wavelet: [1, 1, 1, 1], deconv: 0, saturation: 1 });

    const errs = posted.filter((p) => p.type === 'error');
    const res = last('result');
    const label = colour ? 'colour' : 'mono  ';
    if (errs.length || !res) {
      console.log(`  ${label}  FAILED: ${errs.map((e) => e.message).join('; ') || 'no result'}`);
      failures++;
      continue;
    }
    // Is the output actually coloured, and only where it should be?
    const a = new Uint8ClampedArray(res.rgba);
    const s = res.size;
    let patchDiff = 0, patchN = 0, neutralDiff = 0, neutralN = 0;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const q = (y * s + x) * 4;
        if (a[q + 1] < 20) continue;                        // ignore sky
        const d = a[q] - a[q + 2];                          // R - B
        if (x - s / 2 > 40 && Math.abs(y - s / 2) < 30) { patchDiff += d; patchN++; }
        else if (x < s / 2 - 40) { neutralDiff += d; neutralN++; }
      }
    }
    const pd = patchN ? patchDiff / patchN : 0;
    const nd = neutralN ? neutralDiff / neutralN : 0;
    const cs = res.colour ? `median ${(100 * res.colour.median).toFixed(1)}% p95 ${(100 * res.colour.p95).toFixed(1)}%` : 'not reported';
    console.log(`  ${label}  frames ${res.frames}  aps ${res.aps}  R-B: patch ${pd.toFixed(1)}, elsewhere ${nd.toFixed(1)}  saturation ${cs}`);

    if (!colour) {
      if (Math.abs(pd) > 2 || Math.abs(nd) > 2) { console.log('    FAILED: mono output is not grey'); failures++; }
    } else {
      if (pd < 20) { console.log(`    FAILED: the red patch did not come through (R-B ${pd.toFixed(1)})`); failures++; }
      if (Math.abs(nd) > 8) { console.log(`    FAILED: neutral area is tinted (R-B ${nd.toFixed(1)})`); failures++; }
      if (!res.colour) { console.log('    FAILED: no colour statistic reported'); failures++; }
      // A small vivid patch on a neutral disc is the prominence case: the
      // median is near zero and the high end has to carry the signal.
      else if (res.colour.p95 < 0.15) {
        console.log(`    FAILED: p95 saturation missed a vivid patch (${(100 * res.colour.p95).toFixed(1)}%)`);
        failures++;
      }
    }
    if (hits && hits.size) { console.log(`    FAILED: strided .data reads: ${[...hits.keys()][0]}`); failures++; }
  }
  console.log(failures ? `\n${failures} failure(s)\n` : '\nworker colour path ok\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
