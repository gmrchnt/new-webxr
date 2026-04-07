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
function iou(a, b) {
  // a, b are [x, y, w, h]
  const ax1 = a[0], ay1 = a[1], ax2 = a[0] + a[2], ay2 = a[1] + a[3];
  const bx1 = b[0], by1 = b[1], bx2 = b[0] + b[2], by2 = b[1] + b[3];
  const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  if (ix2 <= ix1 || iy2 <= iy1) return 0;
  const inter = (ix2 - ix1) * (iy2 - iy1);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return inter / (union + 1e-6);
}

const LOG_IOU_THRESH = 0.5;
const LOG_PERSIST_MS = 2000; // must persist for 2 seconds before logging

// Pending detections: waiting to be promoted to the log
// Each: { classId, className, confidence, bbox, firstSeen }
let pendingDets = [];

/**
 * Called every frame with current detections.
 * - Match each det to pending entries via IoU
 * - New dets → add to pending with timestamp
 * - Pending entries not seen this frame → remove (damage gone)
 * - Pending entries alive for 2s+ → promote to damageLog
 */
function logDetections(dets) {
  const now = performance.now();
  const matched = new Set(); // indices of pendingDets that matched this frame

  for (const d of dets) {
    // Already in the permanent log? Skip entirely.
    const inLog = damageLog.some(e =>
      e.classId === d.classId && iou(e.bbox, d.bbox) > LOG_IOU_THRESH
    );
    if (inLog) {
      // Update confidence if improved
      const match = damageLog.find(e =>
        e.classId === d.classId && iou(e.bbox, d.bbox) > LOG_IOU_THRESH
      );
      if (match && d.confidence > match.confidence) {
        match.confidence = d.confidence;
        renderLog();
      }
      continue;
    }

    // Match to a pending entry
    let foundIdx = -1;
    for (let i = 0; i < pendingDets.length; i++) {
      if (matched.has(i)) continue;
      if (pendingDets[i].classId === d.classId && iou(pendingDets[i].bbox, d.bbox) > LOG_IOU_THRESH) {
        foundIdx = i;
        break;
      }
    }

    if (foundIdx >= 0) {
      // Update existing pending entry
      matched.add(foundIdx);
      pendingDets[foundIdx].bbox = d.bbox;
      pendingDets[foundIdx].confidence = Math.max(pendingDets[foundIdx].confidence, d.confidence);

      // Check if it's been 2 seconds → promote to log
      if (now - pendingDets[foundIdx].firstSeen >= LOG_PERSIST_MS) {
        damageLog.push({
          id: logNextId++,
          className: d.className,
          classId: d.classId,
          confidence: pendingDets[foundIdx].confidence,
          timestamp: new Date().toLocaleTimeString(),
          bbox: d.bbox,
        });
        pendingDets.splice(foundIdx, 1);
        renderLog();
      }
    } else {
      // New pending detection
      pendingDets.push({
        classId: d.classId,
        className: d.className,
        confidence: d.confidence,
        bbox: d.bbox,
        firstSeen: now,
      });
    }
  }

  // Remove pending entries that weren't seen this frame (damage moved away)
  pendingDets = pendingDets.filter((_, i) => matched.has(i));
}

function renderLog() {
  $('logCount').textContent = damageLog.length;
  const list = $('logList');
  if (!damageLog.length) {
    list.innerHTML = '<div class="empty-msg">Detected damage will be logged here.</div>';
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

// Delete single log entry
document.addEventListener('click', (e) => {
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
  $('detCount').textContent = dets.length;

  $('sAvg').textContent = dets.length
    ? ((dets.reduce((s, d) => s + d.confidence, 0) / dets.length) * 100).toFixed(0) + '%'
    : '—';

  // Live detections panel (changes every frame)
  const list = $('detList');
  if (!dets.length) {
    list.innerHTML = running
      ? '<div class="empty-msg">Scanning…<br/>No damage detected.</div>'
      : '<div class="empty-msg">No detections yet.</div>';
  } else {
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

  // Log new detections (persistent)
  if (dets.length > 0) logDetections(dets);
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
