import './style.css';
import { loadModel, detect, isModelLoaded } from './detector.js';
import { drawDetections } from './renderer.js';
import { getColor, CLASS_NAMES } from './classes.js';

// ══════════════════════════════════════════════════
//  DOM
// ══════════════════════════════════════════════════
document.getElementById('app').innerHTML = `
  <div class="loading-screen" id="loadingScreen">
    <div class="spinner"></div>
    <div class="loading-label" id="loadingLabel">Initializing…</div>
  </div>
  <div class="toast" id="toast"></div>

  <header class="app-header">
    <div class="logo">
      <div class="logo-mark">◎</div>
      <div class="logo-text">DAMAGE<span>.detect</span></div>
    </div>
    <div class="header-right">
      <div class="badge">
        <div class="dot" id="statusDot"></div>
        <span id="statusLabel">Offline</span>
      </div>
      <div class="badge">
        <span id="fpsVal">0</span>&thinsp;FPS
      </div>
    </div>
  </header>

  <main class="main-grid">
    <section class="feed-col">
      <div class="viewport">
        <video id="video" autoplay playsinline muted></video>
        <canvas id="overlay"></canvas>
        <div class="placeholder" id="placeholder">
          <svg class="placeholder-icon" viewBox="0 0 64 64">
            <rect x="6" y="14" width="52" height="36" rx="4"/>
            <circle cx="32" cy="32" r="10"/>
            <rect x="24" y="10" width="16" height="6" rx="2"/>
          </svg>
          <p>Tap "Start" to begin damage detection</p>
        </div>
      </div>

      <div class="controls">
        <button class="btn btn-primary" id="btnStart">▶ Start</button>
        <button class="btn btn-danger" id="btnStop" disabled>■ Stop</button>
        <button class="btn" id="btnCapture">◉ Capture</button>
        <div class="threshold-group">
          <label>Conf</label>
          <input type="range" id="threshSlider" min="10" max="90" value="40" />
          <span id="threshVal">0.40</span>
        </div>
      </div>
    </section>

    <aside class="sidebar">
      <div class="panel">
        <div class="panel-head">Performance</div>
        <div class="panel-body">
          <div class="stats-grid">
            <div class="stat"><div class="stat-val" id="sDet">0</div><div class="stat-lbl">Detections</div></div>
            <div class="stat"><div class="stat-val" id="sInf">—</div><div class="stat-lbl">Infer (ms)</div></div>
            <div class="stat"><div class="stat-val" id="sFrm">0</div><div class="stat-lbl">Frames</div></div>
            <div class="stat"><div class="stat-val" id="sAvg">—</div><div class="stat-lbl">Avg Conf</div></div>
          </div>
        </div>
      </div>

      <div class="panel grow">
        <div class="panel-head">Live Detections <span class="count" id="detCount">0</span></div>
        <div class="det-scroll" id="detScroll">
          <div class="det-list" id="detList">
            <div class="empty-msg">No detections yet.<br/>Start the camera to begin.</div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">Model</div>
        <div class="panel-body info-rows">
          <div class="row"><span>Architecture</span><span class="v">YOLOv8n</span></div>
          <div class="row"><span>Format</span><span class="v">ONNX</span></div>
          <div class="row"><span>Input</span><span class="v">640 × 640 × 3</span></div>
          <div class="row"><span>Backend</span><span class="v">WASM</span></div>
          <div class="row"><span>Status</span><span class="v" id="iStatus">Not loaded</span></div>
        </div>
      </div>
    </aside>
  </main>
`;

// ══════════════════════════════════════════════════
//  State
// ══════════════════════════════════════════════════
const $ = id => document.getElementById(id);
const $video   = $('video');
const $overlay = $('overlay');
const $ctx     = $overlay.getContext('2d');
let running = false;
let rafId = null;
let threshold = 0.4;
let frames = 0;
let fpsTimes = [];

// ══════════════════════════════════════════════════
//  Model loading
// ══════════════════════════════════════════════════
(async () => {
  $('loadingScreen').classList.remove('hidden');
  $('loadingLabel').textContent = 'Loading YOLOv8n damage model…';
  try {
    await loadModel('/best.onnx');
    $('iStatus').textContent = 'Ready';
    toast('Model loaded');
  } catch (err) {
    console.error(err);
    $('iStatus').textContent = 'Error';
    toast('Model load failed: ' + err.message, true);
  }
  $('loadingScreen').classList.add('hidden');
})();

// ══════════════════════════════════════════════════
//  Camera
// ══════════════════════════════════════════════════
$('btnStart').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    $video.srcObject = stream;
    await $video.play();

    $overlay.width  = $video.videoWidth  || 640;
    $overlay.height = $video.videoHeight || 480;

    $('placeholder').classList.add('hidden');
    $('statusDot').classList.add('live');
    $('statusLabel').textContent = 'Live';
    $('btnStart').disabled = true;
    $('btnStop').disabled  = false;

    running = true;
    frames = 0;
    fpsTimes = [];
    loop();
  } catch (err) {
    toast('Camera denied: ' + err.message, true);
  }
});

$('btnStop').addEventListener('click', () => {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  $video.srcObject?.getTracks().forEach(t => t.stop());
  $video.srcObject = null;
  $ctx.clearRect(0, 0, $overlay.width, $overlay.height);

  $('placeholder').classList.remove('hidden');
  $('statusDot').classList.remove('live');
  $('statusLabel').textContent = 'Offline';
  $('btnStart').disabled = false;
  $('btnStop').disabled  = true;
});

// ══════════════════════════════════════════════════
//  Threshold
// ══════════════════════════════════════════════════
$('threshSlider').addEventListener('input', (e) => {
  threshold = e.target.value / 100;
  $('threshVal').textContent = threshold.toFixed(2);
});

// ══════════════════════════════════════════════════
//  Capture
// ══════════════════════════════════════════════════
$('btnCapture').addEventListener('click', () => {
  const c = document.createElement('canvas');
  c.width  = $overlay.width;
  c.height = $overlay.height;
  const cx = c.getContext('2d');
  cx.drawImage($video, 0, 0, c.width, c.height);
  cx.drawImage($overlay, 0, 0);
  const a = document.createElement('a');
  a.download = `detection-${Date.now()}.png`;
  a.href = c.toDataURL('image/png');
  a.click();
  toast('Screenshot saved');
});

// ══════════════════════════════════════════════════
//  Detection loop
// ══════════════════════════════════════════════════
async function loop() {
  if (!running) return;

  const t0 = performance.now();
  let dets = [];

  if (isModelLoaded()) {
    try { dets = await detect($video, threshold); }
    catch (e) { console.warn('Inference err:', e); }
  }

  const ms = (performance.now() - t0).toFixed(1);

  drawDetections($ctx, dets, $video, $overlay);
  updateUI(dets, ms);

  frames++;
  const now = performance.now();
  fpsTimes.push(now);
  fpsTimes = fpsTimes.filter(t => now - t < 1000);
  $('fpsVal').textContent = fpsTimes.length;

  rafId = requestAnimationFrame(loop);
}

// ══════════════════════════════════════════════════
//  UI updates
// ══════════════════════════════════════════════════
function updateUI(dets, ms) {
  $('sDet').textContent = dets.length;
  $('sInf').textContent = ms;
  $('sFrm').textContent = frames;
  $('detCount').textContent = dets.length;

  $('sAvg').textContent = dets.length
    ? ((dets.reduce((s, d) => s + d.confidence, 0) / dets.length) * 100).toFixed(0) + '%'
    : '—';

  const list = $('detList');
  if (!dets.length) {
    list.innerHTML = running
      ? '<div class="empty-msg">Scanning…<br/>No damage detected.</div>'
      : '<div class="empty-msg">No detections yet.</div>';
    return;
  }

  list.innerHTML = dets
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 25)
    .map(d => `
      <div class="det-item" style="border-left-color:${getColor(d.classId)}">
        <div class="det-swatch" style="background:${getColor(d.classId)}"></div>
        <span class="det-label">${d.className}</span>
        <span class="det-conf">${(d.confidence * 100).toFixed(1)}%</span>
      </div>
    `).join('');
}

// ══════════════════════════════════════════════════
//  Toast
// ══════════════════════════════════════════════════
function toast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' error' : '');
  setTimeout(() => el.classList.remove('show'), 3000);
}
