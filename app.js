// SolFuse main thread: pull frames out of a video, drive the worker through two
// passes, export. Everything heavy lives in worker.js and pipeline.js.

const V = new URL(import.meta.url).search;

const $ = (id) => document.getElementById(id);
const drop = $('drop'), fileInput = $('file'), status = $('status'), detail = $('detail');
const bar = $('bar'), barFill = bar.firstElementChild, out = $('out'), exports = $('exports');
const video = $('vid'), go = $('go'), meta = $('meta');

let worker = null, busy = false, file = null, lastResult = null;

// --- worker plumbing ------------------------------------------------------

const waiters = new Map();

function spawn() {
  if (worker) worker.terminate();
  waiters.clear();
  worker = new Worker('worker.js' + V);
  worker.onmessage = (e) => {
    const { type } = e.data;
    if (type === 'error') { const r = waiters.get('__err'); if (r) r(e.data); return; }
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
  bar.classList.add('on');
  setProgress(1, 'Starting engine…');

  const w = video.videoWidth, h = video.videoHeight;
  const opts = options();
  const dur = video.duration || 1;

  try {
    spawn();
    const began = await call({ type: 'begin', w, h, opts }, 'began');

    const send = (phase) => async (rgba, index, seq) => {
      const gray = greenPlane(rgba, w, h);
      await call({ type: 'frame', gray: gray.buffer, index, seq, phase }, 'framed', [gray.buffer]);
    };

    setProgress(4, 'Pass 1 of 2 — aligning on the disc…');
    const p1 = await extractFrames(send(1), (t, n) => {
      setProgress(4 + (44 * t) / dur, `Pass 1 of 2 — ${n} frames aligned…`);
    }, 1);

    const ref = await call({ type: 'buildRef' }, 'refReady');
    if (!ref.frames) throw new Error('No frames could be read from the video.');

    let p2 = { seq: 0, dropped: 0 };
    if (opts.multipoint) {
      setProgress(50, `Pass 2 of 2 — ${ref.aps} alignment points…`);
      p2 = await extractFrames(send(2), (t, n) => {
        setProgress(50 + (46 * t) / dur, `Pass 2 of 2 — refining frame ${n}…`);
      }, 1);
    }

    setProgress(97, 'Rendering…');
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
  $('preview').hidden = false;
  exports.hidden = false;
  bar.classList.remove('on');
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

  const dropped = (p1.dropped || 0) + (p2.dropped || 0);
  if (dropped > 0) {
    say(`${bits[0]} — but the decoder dropped ${dropped} frame${dropped > 1 ? 's' : ''}. ` +
        `The result is still valid, just built from fewer frames.`, true);
  }
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

window.__sf.booted = true;
