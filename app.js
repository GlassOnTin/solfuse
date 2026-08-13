// SolFuse main thread: pull frames out of a video, drive the worker through two
// passes, export. Everything heavy lives in worker.js and pipeline.js.

const V = new URL(import.meta.url).search;

const $ = (id) => document.getElementById(id);
const drop = $('drop'), fileInput = $('file'), status = $('status'), detail = $('detail');
const bar = $('bar'), barFill = bar.firstElementChild, out = $('out'), exports = $('exports');
const video = $('vid'), go = $('go'), meta = $('meta');
const live = $('live'), prev = $('prev'), ovl = $('ovl'), timeline = $('timeline');
const compare = $('compare'), before = $('before'), wipe = $('wipe'), handle = $('handle');

let worker = null, busy = false, file = null, lastResult = null;

// Telemetry for the live view. Kept on the main thread so the worker never
// waits on drawing.
let apPositions = [], apCanvas = 0, lastGrid = null, gridN = 0;
let apCells = new Set();   // grid cells that carry a real measurement
let track = [];            // per-frame { field, refine, cx, cy }

// --- worker plumbing ------------------------------------------------------

const waiters = new Map();

function spawn() {
  if (worker) worker.terminate();
  waiters.clear();
  worker = new Worker('worker.js' + V);
  worker.onmessage = (e) => {
    const { type } = e.data;
    if (type === 'error') { const r = waiters.get('__err'); if (r) r(e.data); return; }
    // Previews are unsolicited: they arrive between replies and must not be
    // mistaken for the reply something is waiting on.
    if (type === 'preview') { onPreview(e.data); return; }
    const w = waiters.get(type);
    if (w) { waiters.delete(type); w(e.data); }
  };
  worker.onerror = (e) => fail(e.message || 'Worker crashed.');
  worker.onmessageerror = () => fail('Lost a message from the worker.');
  return worker;
}

function call(msg, waitFor, transfer) {
  return new Promise((resolve, reject) => {
    waiters.set(waitFor, resolve);
    waiters.set('__err', (d) => { waiters.delete(waitFor); reject(Object.assign(new Error(d.message), d)); });
    worker.postMessage(msg, transfer || []);
  });
}

// --- input ----------------------------------------------------------------

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && fileInput.click());
fileInput.addEventListener('change', () => pick(fileInput.files[0]));
for (const ev of ['dragenter', 'dragover']) {
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
}
for (const ev of ['dragleave', 'drop']) {
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
}
drop.addEventListener('drop', (e) => {
  const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('video/'));
  if (f) pick(f);
});

async function pick(f) {
  if (!f || busy) return;
  file = f;
  video.src = URL.createObjectURL(f);
  await new Promise((r, j) => {
    video.onloadedmetadata = r;
    video.onerror = () => j(new Error('This browser cannot decode that video.'));
  }).catch((e) => fail(e.message));
  if (!video.videoWidth) return;
  meta.textContent = `${f.name} · ${video.videoWidth}×${video.videoHeight} · ` +
                     `${video.duration.toFixed(1)}s`;
  meta.hidden = false;
  go.disabled = false;
  say('Ready. Stacking reads the video twice — once to align, once to refine.');
}

// --- frame extraction -----------------------------------------------------
//
// requestVideoFrameCallback fires once per frame the compositor actually
// presents, and hands over the frame's own presentation time. That timestamp,
// not a counter, is the frame's identity: if the browser presents a slightly
// different set of frames on the second pass, matching by time still lines the
// two passes up, whereas matching by count would silently pair the wrong frames.

function extractFrames(onFrame, onProgress, rate) {
  return new Promise((resolve, reject) => {
    if (!video.requestVideoFrameCallback) {
      reject(new Error('This browser lacks requestVideoFrameCallback — try current Chrome or Safari.'));
      return;
    }
    const w = video.videoWidth, h = video.videoHeight;
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d', { willReadFrequently: true });
    let seq = 0, lastPresented = null, dropped = 0, lastTime = -1;
    let stop = false;

    const done = () => {
      video.pause();
      video.onended = null;
      resolve({ seq, dropped });
    };

    const tick = async (now, md) => {
      if (stop) return;
      // presentedFrames counts every frame the compositor showed. A jump means
      // the decoder could not keep up and frames went past unseen.
      if (lastPresented !== null && md.presentedFrames - lastPresented > 1) {
        dropped += md.presentedFrames - lastPresented - 1;
      }
      lastPresented = md.presentedFrames;

      const t = md.mediaTime;
      if (t > lastTime) {                       // guard against a repeated frame
        lastTime = t;
        g.drawImage(video, 0, 0, w, h);
        const id = g.getImageData(0, 0, w, h);
        await onFrame(id.data, Math.round(t * 1000), seq++);
        if (onProgress) onProgress(t, seq);
      }
      if (video.ended) { done(); return; }
      video.requestVideoFrameCallback(tick);
    };

    video.onended = () => { stop = false; done(); };
    video.onerror = () => reject(new Error('Video decoding failed part-way through.'));
    video.currentTime = 0;
    video.playbackRate = rate || 1;
    video.muted = true;
    video.requestVideoFrameCallback(tick);
    video.play().catch((e) => reject(new Error('Could not play the video: ' + e.message)));
  });
}

// Green channel only. The disc through a white-light filter carries no colour,
// and sending one plane instead of four cuts the transfer to the worker by 75%.
function greenPlane(rgba, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0, p = 1; i < g.length; i++, p += 4) g[i] = rgba[p];
  return g;
}

// --- live view ------------------------------------------------------------

function onPreview(d) {
  const n = d.size;
  prev.width = n; prev.height = n;
  prev.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(d.rgba), n, n), 0, 0);
  if (d.grid) {
    lastGrid = { n: d.grid.n, gx: new Float32Array(d.grid.gx), gy: new Float32Array(d.grid.gy) };
    gridN = d.grid.n;
  }
  drawOverlay();
}

// Which grid cells an alignment point actually sits in, so the overlay can draw
// measurements and not interpolation.
function indexAPs(grid) {
  gridN = grid || gridN;
  apCells = new Set();
  if (!gridN || !apCanvas) return;
  const step = apCanvas / gridN;
  for (const [x, y] of apPositions) {
    const i = Math.round(x / step - 0.5), j = Math.round(y / step - 0.5);
    if (i >= 0 && j >= 0 && i < gridN && j < gridN) apCells.add(j * gridN + i);
  }
}

// The alignment points, and the displacement each one measured. This is the
// whole argument for multi-point alignment in one picture: the vectors do not
// all point the same way, so no single shift of the whole frame could remove
// them. They are exaggerated because the real motion is only 1-2 px.
function drawOverlay() {
  const n = prev.width || 420;
  ovl.width = n; ovl.height = n;
  const g = ovl.getContext('2d');
  g.clearRect(0, 0, n, n);
  if (!apCanvas) return;
  const k = n / apCanvas;
  const scale = Number($('vecScale').value);

  if ($('showField').checked && lastGrid) {
    const step = apCanvas / lastGrid.n;
    for (let j = 0; j < lastGrid.n; j++) {
      for (let i = 0; i < lastGrid.n; i++) {
        // Only cells that carry an actual alignment point. The rest of the grid
        // is filled by interpolation so the warp stays smooth, and drawing that
        // would show confident arrows over empty sky where nothing was measured.
        if (!apCells.has(j * lastGrid.n + i)) continue;
        const idx = j * lastGrid.n + i;
        const dx = lastGrid.gx[idx], dy = lastGrid.gy[idx];
        const mag = Math.hypot(dx, dy);
        if (mag < 0.02) continue;
        const x = (i + 0.5) * step * k, y = (j + 0.5) * step * k;
        // Warm for large excursions, cool for small ones.
        const t = Math.min(1, mag / 3);
        g.strokeStyle = `rgba(${Math.round(120 + 135 * t)},${Math.round(200 - 90 * t)},${Math.round(255 - 200 * t)},0.85)`;
        g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + dx * scale * k, y + dy * scale * k);
        g.stroke();
      }
    }
  }
  if ($('showAps').checked && apPositions.length) {
    g.fillStyle = 'rgba(255,180,84,0.75)';
    for (const [x, y] of apPositions) {
      g.beginPath();
      g.arc(x * k, y * k, 1.6, 0, 6.283);
      g.fill();
    }
  }
}
for (const id of ['showAps', 'showField', 'vecScale']) $(id).addEventListener('change', drawOverlay);

// Distortion magnitude over time. Seeing wanders on a timescale of roughly a
// second, so a smooth meander is the expected shape; spikes usually mean a
// frame failed to match rather than that the air moved.
function drawTimeline() {
  const w = timeline.clientWidth || 800, h = 64;
  timeline.width = w; timeline.height = h;
  const g = timeline.getContext('2d');
  g.clearRect(0, 0, w, h);
  const vals = track.map((t) => t.field).filter((v) => v != null);
  if (vals.length < 2) return;
  const max = Math.max(0.5, ...vals);
  g.strokeStyle = '#ffb454'; g.lineWidth = 1.4; g.beginPath();
  vals.forEach((v, i) => {
    const x = (i / (vals.length - 1)) * (w - 8) + 4;
    const y = h - 6 - (v / max) * (h - 16);
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.stroke();
  g.fillStyle = '#a89880'; g.font = '10px system-ui';
  g.fillText(`${max.toFixed(2)} px`, 6, 12);
  g.fillText(`${vals.length} frames`, w - 66, h - 6);
}

function setStage(n) {
  for (let i = 1; i <= 3; i++) {
    const el = $('stage' + i);
    el.classList.toggle('on', i === n);
    el.classList.toggle('done', i < n);
  }
  $('explain').textContent = {
    1: 'Finding the solar disc in each frame and removing whole-frame drift — centroid first, then an ECC refinement. The stack you can see building is the reference the next pass needs.',
    2: 'Each alignment point is located independently, giving a displacement field. Different parts of the disc move by different amounts, which is exactly what a single global shift cannot fix.',
    3: 'Stretching and rendering the result.',
  }[n] || '';
}

// --- stacking -------------------------------------------------------------

go.addEventListener('click', () => run());

const options = () => ({
  canvas: Number($('canvas').value),
  multipoint: $('doMulti').checked,
  step: Number($('step').value),
  search: Number($('search').value),
});

const renderOpts = () => ({
  lo: 0.2, hi: 99.9,
  sharpen: Number($('sharpen').value),
  sharpenRadius: Number($('radius').value),
});

async function run() {
  if (busy || !file) return;
  busy = true; go.disabled = true; exports.hidden = true; detail.textContent = '';
  compare.hidden = true; $('stats').hidden = true;
  live.hidden = false; track = []; lastGrid = null; apPositions = [];
  bar.classList.add('on');
  setStage(1);
  setProgress(1, 'Starting engine…');

  const w = video.videoWidth, h = video.videoHeight;
  const opts = options();
  const dur = video.duration || 1;

  try {
    spawn();
    const began = await call({ type: 'begin', w, h, opts }, 'began');

    const send = (phase) => async (rgba, index, seq) => {
      const gray = greenPlane(rgba, w, h);
      const r = await call({ type: 'frame', gray: gray.buffer, index, seq, phase }, 'framed', [gray.buffer]);
      track.push({ field: r.field, refine: r.refine, cx: r.cx, cy: r.cy });
      if (seq % 10 === 0) drawTimeline();
    };

    setProgress(4, 'Pass 1 of 2 — aligning on the disc…');
    const p1 = await extractFrames(send(1), (t, n) => {
      setProgress(4 + (44 * t) / dur, `Pass 1 of 2 — ${n} frames aligned…`);
    }, 1);

    const ref = await call({ type: 'buildRef' }, 'refReady');
    if (!ref.frames) throw new Error('No frames could be read from the video.');
    apPositions = ref.apPositions || [];
    apCanvas = ref.canvas;
    indexAPs(ref.grid);
    drawOverlay();

    let p2 = { seq: 0, dropped: 0 };
    if (opts.multipoint) {
      setStage(2);
      track = [];
      setProgress(50, `Pass 2 of 2 — ${ref.aps} alignment points…`);
      p2 = await extractFrames(send(2), (t, n) => {
        setProgress(50 + (46 * t) / dur, `Pass 2 of 2 — refining frame ${n}…`);
      }, 1);
    }

    setStage(3);
    drawTimeline();
    setProgress(97, 'Rendering and measuring…');
    const res = await call(Object.assign({ type: 'finish' }, renderOpts()), 'result');
    finish(res, ref, p1, p2);
  } catch (err) {
    if (err.oom || /memory|allocat/i.test(err.message || '')) {
      fail(`Out of memory. Try a smaller output size under Advanced. (${err.message})`);
    } else {
      fail(err.message || String(err));
    }
  }
}

function finish(res, ref, p1, p2) {
  out.width = res.size; out.height = res.size;
  out.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(res.rgba), res.size, res.size), 0, 0);
  if (res.beforeRgba) {
    before.hidden = false;
    before.width = res.size; before.height = res.size;
    before.getContext('2d').putImageData(
      new ImageData(new Uint8ClampedArray(res.beforeRgba), res.size, res.size), 0, 0);
  } else {
    before.hidden = true;
  }
  $('tagAfter').textContent = `stacked · ${res.frames} frames`;
  setWipe(wipe.value);
  compare.hidden = false;
  exports.hidden = false;
  bar.classList.remove('on');
  setStage(4);
  busy = false; go.disabled = false;
  lastResult = res;

  const bits = [
    `${res.frames} frames stacked at ${res.size}×${res.size}`,
    ref.medianRefine != null ? `global refinement ${ref.medianRefine.toFixed(2)} px` : null,
    res.aps ? `${res.aps} alignment points, ${res.apsUsed ? res.apsUsed.toFixed(0) : '?'} used per frame` : 'multi-point off',
    res.fieldMedian != null ? `distortion ${res.fieldMedian.toFixed(2)} px median` : null,
    res.mem ? `${res.mem.accumulatorMB} MB accumulators` : null,
  ].filter(Boolean);
  say(bits[0]);
  detail.textContent = bits.slice(1).join(' · ');
  showStats(res, ref, p1, p2);

  const dropped = (p1.dropped || 0) + (p2.dropped || 0);
  if (dropped > 0) {
    say(`${bits[0]} — but the decoder dropped ${dropped} frame${dropped > 1 ? 's' : ''}. ` +
        `The result is still valid, just built from fewer frames.`, true);
  }
}

// Everything here is measured on this run. Where a number could not be
// computed it is omitted rather than guessed at.
function showStats(res, ref, p1, p2) {
  const q = res.quality || {};
  const rows = [];
  const add = (k, v, note) => rows.push([k, v, note || '']);
  const head = (t) => rows.push(['__head', t, '']);
  const px = (v, d) => (v == null ? null : v.toFixed(d == null ? 2 : d) + ' px');

  head('Input');
  add('Frames stacked', String(res.frames));
  add('Output size', `${res.size} × ${res.size}`);
  const drops = (p1.dropped || 0) + (p2.dropped || 0);
  add('Frames dropped by the decoder', String(drops),
      drops ? 'The decoder could not keep up; the result uses what arrived.' : 'None — every presented frame was used.');

  head('Alignment');
  add('Global refinement beyond centroid', px(ref.medianRefine),
      'Median ECC correction on top of the disc centroid.');
  if (ref.eccFailures) add('ECC failures', String(ref.eccFailures), 'Fell back to the centroid alone.');
  if (res.aps) {
    add('Alignment points', String(res.aps), `On a ${ref.grid}×${ref.grid} grid, keeping those with enough structure to locate.`);
    add('Points located per frame', res.apsUsed ? res.apsUsed.toFixed(0) : '—',
        'The rest were interpolated from their neighbours.');
    add('Differential distortion', px(res.fieldMedian),
        'Median displacement across the disc after global alignment — the part no single shift can remove.');
  }

  head('Result quality');
  if (q.frameNoise != null && q.stackNoise != null) {
    add('Noise in one frame', q.frameNoise.toFixed(3) + ' DN');
    add('Noise in the stack', q.stackNoise.toFixed(3) + ' DN',
        'From the difference between the odd- and even-frame stacks.');
    add('Noise reduction', '×' + q.noiseReduction.toFixed(1),
        `√${res.frames} = ${Math.sqrt(res.frames).toFixed(1)} would be the ideal for independent frames; ` +
        'inter-frame video compression and residual misalignment both cost you some of it.');
  }
  if (q.globalSNR != null) {
    add('Split-half SNR, global alignment', q.globalSNR.toFixed(1), `r = ${q.globalR.toFixed(4)}`);
  }
  if (q.multiSNR != null) {
    add('Split-half SNR, multi-point', q.multiSNR.toFixed(1), `r = ${q.multiR.toFixed(4)}`);
  }
  if (q.snrGain != null) {
    add('Multi-point gain', '×' + q.snrGain.toFixed(2),
        q.snrGain > 1.05 ? 'The second pass earned its keep on this clip.'
                         : 'Little gained here — the seeing was steady, or the frames are too compressed to improve.');
  }
  if (q.error) add('Statistics', 'unavailable', q.error);

  $('statTable').innerHTML = rows.map(([k, v, note]) =>
    k === '__head'
      ? `<tr class="head"><td colspan="2">${v}</td></tr>`
      : `<tr><td>${k}</td><td class="v">${v}${note ? `<div class="note">${note}</div>` : ''}</td></tr>`
  ).join('');
  $('stats').hidden = false;
}

// --- before/after wipe ----------------------------------------------------

function setWipe(pct) {
  before.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
  handle.style.left = `${pct}%`;
}
wipe.addEventListener('input', () => setWipe(wipe.value));
function wipeFrom(clientX) {
  const r = compare.getBoundingClientRect();
  if (!r.width) return;
  wipe.value = Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100));
  setWipe(wipe.value);
}
let wiping = false;
compare.addEventListener('pointerdown', (e) => {
  wiping = true;
  try { compare.setPointerCapture(e.pointerId); } catch { /* capture is a bonus */ }
  wipeFrom(e.clientX);
});
compare.addEventListener('pointermove', (e) => { if (wiping || (e.buttons & 1)) wipeFrom(e.clientX); });
for (const ev of ['pointerup', 'pointercancel']) {
  window.addEventListener(ev, () => { wiping = false; });
}

// --- messaging ------------------------------------------------------------

function fail(message) {
  bar.classList.remove('on');
  busy = false; go.disabled = !file;
  say(message, true);
  window.__sf?.record?.('app', message);
}

function setProgress(pct, msg) {
  barFill.style.width = `${Math.min(100, pct)}%`;
  if (msg) say(msg);
}

function say(text, isError) {
  status.textContent = text;
  status.classList.toggle('err', !!isError);
}

// --- export ---------------------------------------------------------------

const stem = () => (file?.name.replace(/\.[^.]+$/, '') || 'solfuse') + '-stacked';

function download(blob, ext) {
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob), download: `${stem()}.${ext}`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

const save = (ext, type, q) => out.toBlob((b) => {
  if (b) download(b, ext);
  else fail(`Could not encode the ${ext.toUpperCase()} — the image may be too large for this device.`);
}, type, q);

$('dlPng').addEventListener('click', () => save('png', 'image/png'));
$('dlJpg').addEventListener('click', () => save('jpg', 'image/jpeg', 0.95));

// Sharpening only changes the render, so it reuses the stack already in memory.
let t = null;
for (const id of ['sharpen', 'radius']) {
  $(id).addEventListener('input', () => {
    if (busy || exports.hidden || !worker) return;
    clearTimeout(t);
    t = setTimeout(async () => {
      try {
        const r = await call(Object.assign({ type: 'rerender' }, renderOpts()), 'result');
        out.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.rgba), r.size, r.size), 0, 0);
      } catch { /* stack may have been freed; keep the last render */ }
    }, 150);
  });
}

for (const r of document.querySelectorAll('#adv input[type=range]')) {
  const show = () => (r.parentElement.querySelector('output').value = (+r.value).toFixed(2));
  r.addEventListener('input', show);
  show();
}

if (!window.Worker || !window.OffscreenCanvas || !HTMLVideoElement.prototype.requestVideoFrameCallback) {
  say('This browser is missing Web Workers, OffscreenCanvas or requestVideoFrameCallback — try a current Chrome or Safari.', true);
  go.disabled = true;
}

// Exposed deliberately. The video path cannot be exercised in an automation
// browser — those lack a media pipeline entirely — so everything downstream of
// frame extraction is driven directly through these during testing.
window.__sf.ui = {
  onPreview, drawOverlay, drawTimeline, setStage, showStats, finish, setWipe,
  setAPs: (pos, canvas, grid) => { apPositions = pos; apCanvas = canvas; indexAPs(grid); drawOverlay(); },
  setTrack: (t) => { track = t; drawTimeline(); },
};

window.__sf.booted = true;
