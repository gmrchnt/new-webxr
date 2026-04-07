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

      <div class="panel grow">
        <div class="panel-head">
          Damage Log <span class="count" id="logCount">0</span>
          <button class="log-clear-btn" id="btnClearLog">Clear</button>
        </div>
        <div class="det-scroll">
          <div class="det-list" id="logList">
            <div class="empty-msg">Detected damage will be logged here.</div>
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

// Persistent damage log
let damageLog = [];    // { id, className, classId, confidence, timestamp, bbox }
let logNextId = 1;

// Live detections with persistence (3 second TTL)
const LIVE_TTL = 3000;
let liveDets = [];  // { classId, className, confidence, bbox, lastSeen }
let currentDets = []; // reference for click handler

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

// Store current frame's detections so click handler can access them

function renderLog() {
  $('logCount').textContent = damageLog.length;
  const list = $('logList');
  if (!damageLog.length) {
    list.innerHTML = '<div class="empty-msg">Tap a live detection to log it.</div>';
    return;
  }
  list.innerHTML = damageLog.slice().reverse().map(e => `
    <div class="det-item log-entry" style="border-left-color:${getColor(e.classId)}">
      <div class="det-swatch" style="background:${getColor(e.classId)}"></div>
      <span class="det-label">${e.className}</span>
      <span class="det-conf">${(e.confidence * 100).toFixed(0)}%</span>
      <span class="det-time">${e.timestamp}</span>
      <button class="log-del" data-id="${e.id}">✕</button>
    </div>
  `).join('');
}

// Click on a live detection → add to damage log
document.addEventListener('click', (e) => {
  const item = e.target.closest('.live-det-item');
  if (item) {
    const idx = +item.dataset.idx;
    const d = currentDets[idx];
    if (!d) return;

    damageLog.push({
      id: logNextId++,
      className: d.className,
      classId: d.classId,
      confidence: d.confidence,
      timestamp: new Date().toLocaleTimeString(),
      bbox: d.bbox,
    });
    renderLog();
    toast(`Logged: ${d.className} ${(d.confidence * 100).toFixed(0)}%`);
    return;
  }

  // Delete log entry
  if (e.target.classList.contains('log-del')) {
    const id = +e.target.dataset.id;
    damageLog = damageLog.filter(e => e.id !== id);
    renderLog();
  }
});

// Clear all logs
$('btnClearLog').addEventListener('click', () => {
  damageLog = [];
  logNextId = 1;
  renderLog();
});

function updateUI(dets, ms) {
  $('sDet').textContent = dets.length;
  $('sInf').textContent = ms;
  $('sFrm').textContent = frames;

  const now = performance.now();

  // Update live detections: merge new dets, refresh timestamps
  for (const d of dets) {
    // Find existing live entry: same class + overlapping region
    const existing = liveDets.find(l =>
      l.classId === d.classId && bboxOverlap(l.bbox, d.bbox)
    );
    if (existing) {
      // Refresh: update bbox, confidence, and reset timer
      existing.bbox = d.bbox;
      existing.confidence = Math.max(existing.confidence, d.confidence);
      existing.lastSeen = now;
    } else {
      // New live detection
      liveDets.push({
        classId: d.classId,
        className: d.className,
        confidence: d.confidence,
        bbox: d.bbox,
        lastSeen: now,
      });
    }
  }

  // Prune: remove entries older than 3 seconds
  liveDets = liveDets.filter(l => now - l.lastSeen < LIVE_TTL);

  // Store sorted for click handler
  currentDets = liveDets.sort((a, b) => b.confidence - a.confidence).slice(0, 25);

  $('detCount').textContent = currentDets.length;
  $('sAvg').textContent = currentDets.length
    ? ((currentDets.reduce((s, d) => s + d.confidence, 0) / currentDets.length) * 100).toFixed(0) + '%'
    : '—';

  // Render live detections panel
  const list = $('detList');
  if (!currentDets.length) {
    list.innerHTML = running
      ? '<div class="empty-msg">Scanning…<br/>No damage detected.</div>'
      : '<div class="empty-msg">No detections yet.</div>';
  } else {
    list.innerHTML = currentDets.map((d, i) => {
      // Show time remaining as opacity fade
      const age = now - d.lastSeen;
      const opacity = Math.max(0.4, 1 - (age / LIVE_TTL) * 0.6);
      return `
        <div class="det-item live-det-item" data-idx="${i}" style="border-left-color:${getColor(d.classId)}; cursor:pointer; opacity:${opacity.toFixed(2)};" title="Tap to log">
          <div class="det-swatch" style="background:${getColor(d.classId)}"></div>
          <span class="det-label">${d.className}</span>
          <span class="det-conf">${(d.confidence * 100).toFixed(1)}%</span>
          <span class="det-add">+</span>
        </div>
      `;
    }).join('');
  }
}

// Simple overlap check: do two bboxes [x,y,w,h] overlap significantly?
function bboxOverlap(a, b) {
  const ax1 = a[0], ay1 = a[1], ax2 = a[0]+a[2], ay2 = a[1]+a[3];
  const bx1 = b[0], by1 = b[1], bx2 = b[0]+b[2], by2 = b[1]+b[3];
  const ix = Math.max(0, Math.min(ax2,bx2) - Math.max(ax1,bx1));
  const iy = Math.max(0, Math.min(ay2,by2) - Math.max(ay1,by1));
  const inter = ix * iy;
  const smaller = Math.min(a[2]*a[3], b[2]*b[3]);
  return inter > smaller * 0.3;
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
