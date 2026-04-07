import './style.css';
import { loadModel, detect, isModelLoaded } from './detector.js';
import { getColor, CLASS_NAMES } from './classes.js';
import {
  startARSession, endARSession, getSession, getRefSpace,
  onXRFrame, hitTestAtPoint, measureBBoxDiagonal,
  distance3D, formatDistance, isARSupported,
} from './ar.js';
import * as log from './log.js';

// ── Render DOM ──
document.getElementById('app').innerHTML = `
  <div class="loading-screen" id="loadingScreen">
    <div class="spinner"></div>
    <div class="loading-label" id="loadingLabel">Initializing…</div>
  </div>

  <div class="toast" id="toast"></div>

  <!-- AR DOM overlay — visible during XR session -->
  <div id="ar-overlay" class="ar-overlay hidden">
    <canvas id="arCanvas"></canvas>

    <div class="ar-hud">
      <div class="ar-hud-top">
        <div class="ar-badge">
          <div class="dot live"></div>
          <span id="arStatusLabel">AR Live</span>
        </div>
        <div class="ar-badge"><span id="arFps">0</span>&thinsp;FPS</div>
        <div class="mode-switch">
          <button class="mode-btn active" id="btnMode1" data-mode="manual">Mode 1 · Manual</button>
          <button class="mode-btn" id="btnMode2" data-mode="auto">Mode 2 · Auto</button>
        </div>
      </div>

      <!-- Mode 1: manual controls -->
      <div class="ar-manual-controls" id="manualControls">
        <div class="manual-status" id="manualStatus">Tap first point on damage</div>
        <div class="manual-class-row" id="manualClassRow" style="display:none;">
          <select id="manualClassSelect" class="class-select">
            ${CLASS_NAMES.map((c, i) => `<option value="${i}">${c}</option>`).join('')}
          </select>
          <button class="btn btn-primary btn-sm" id="btnLogManual">Log Damage</button>
          <button class="btn btn-danger btn-sm" id="btnResetPoints">Reset</button>
        </div>
      </div>

      <!-- Mode 2: auto info -->
      <div class="ar-auto-info hidden" id="autoInfo">
        <div class="auto-status" id="autoStatus">Detecting damage…</div>
        <div class="threshold-group">
          <label>Conf</label>
          <input type="range" id="arThreshSlider" min="10" max="90" value="40" />
          <span id="arThreshVal">0.40</span>
        </div>
      </div>
    </div>

    <!-- Sidebar log panel (floating in AR) -->
    <div class="ar-sidebar" id="arSidebar">
      <div class="panel">
        <div class="panel-head">
          Damage Log
          <span class="count" id="logCount">0</span>
        </div>
        <div class="det-scroll" id="logScroll">
          <div class="det-list" id="logList">
            <div class="empty-msg">No entries yet.</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Manual tap point markers drawn on this canvas -->
    <canvas id="pointCanvas"></canvas>
  </div>

  <!-- Non-AR landing page -->
  <header class="app-header" id="mainHeader">
    <div class="logo">
      <div class="logo-mark">◎</div>
      <div class="logo-text">DAMAGE<span>.detect</span></div>
    </div>
    <div class="header-right">
      <div class="badge">
        <div class="dot" id="statusDot"></div>
        <span id="statusLabel">Offline</span>
      </div>
    </div>
  </header>

  <main class="main-grid" id="mainGrid">
    <section class="feed-col">
      <div class="viewport">
        <div class="placeholder" id="placeholder">
          <svg class="placeholder-icon" viewBox="0 0 64 64">
            <rect x="6" y="14" width="52" height="36" rx="4"/>
            <circle cx="32" cy="32" r="10"/>
            <rect x="24" y="10" width="16" height="6" rx="2"/>
          </svg>
          <p>Tap "Start AR" to begin damage inspection</p>
        </div>
      </div>
      <div class="controls">
        <button class="btn btn-primary" id="btnStartAR">▶ Start AR</button>
        <button class="btn btn-danger" id="btnStopAR" disabled>■ Stop AR</button>
        <button class="btn" id="btnClearLog">⊘ Clear Log</button>
      </div>
    </section>

    <aside class="sidebar">
      <div class="panel">
        <div class="panel-head">Performance</div>
        <div class="panel-body">
          <div class="stats-grid">
            <div class="stat"><div class="stat-val" id="sDet">0</div><div class="stat-lbl">Detections</div></div>
            <div class="stat"><div class="stat-val" id="sInf">—</div><div class="stat-lbl">Infer (ms)</div></div>
            <div class="stat"><div class="stat-val" id="sLog">0</div><div class="stat-lbl">Logged</div></div>
            <div class="stat"><div class="stat-val" id="sMode">—</div><div class="stat-lbl">Mode</div></div>
          </div>
        </div>
      </div>

      <div class="panel grow">
        <div class="panel-head">Damage Log <span class="count" id="logCountMain">0</span></div>
        <div class="det-scroll">
          <div class="det-list" id="logListMain">
            <div class="empty-msg">No entries yet.<br/>Start AR to begin inspection.</div>
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
let currentMode = 'manual'; // 'manual' | 'auto'
let arActive = false;
let threshold = 0.4;
let frames = 0;
let fpsTimes = [];

// Mode 1 state
let manualPoint1 = null; // { screenX, screenY, world: {x,y,z} }
let manualPoint2 = null;
let manualMeasuredLength = null;

// XR frame references
let currentFrame = null;
let currentRefSpace = null;

// ══════════════════════════════════════════════════
//  Element refs
// ══════════════════════════════════════════════════
const $loading     = document.getElementById('loadingScreen');
const $loadLabel   = document.getElementById('loadingLabel');
const $arOverlay   = document.getElementById('ar-overlay');
const $arCanvas    = document.getElementById('arCanvas');
const $pointCanvas = document.getElementById('pointCanvas');
const $pointCtx    = $pointCanvas.getContext('2d');
const $btnStartAR  = document.getElementById('btnStartAR');
const $btnStopAR   = document.getElementById('btnStopAR');
const $btnClearLog = document.getElementById('btnClearLog');
const $btnMode1    = document.getElementById('btnMode1');
const $btnMode2    = document.getElementById('btnMode2');
const $manualCtrls = document.getElementById('manualControls');
const $autoInfo    = document.getElementById('autoInfo');
const $manualStatus = document.getElementById('manualStatus');
const $manualClassRow = document.getElementById('manualClassRow');
const $manualClassSel = document.getElementById('manualClassSelect');
const $btnLogManual = document.getElementById('btnLogManual');
const $btnResetPts  = document.getElementById('btnResetPoints');
const $autoStatus   = document.getElementById('autoStatus');
const $arThreshSlider = document.getElementById('arThreshSlider');
const $arThreshVal  = document.getElementById('arThreshVal');

// ══════════════════════════════════════════════════
//  Model loading
// ══════════════════════════════════════════════════
async function initModel() {
  $loading.classList.remove('hidden');
  $loadLabel.textContent = 'Loading YOLOv8n damage model…';
  try {
    await loadModel('/best.onnx');
    document.getElementById('iStatus').textContent = 'Ready';
    toast('Model loaded');
  } catch (err) {
    console.error(err);
    document.getElementById('iStatus').textContent = 'Error';
    toast('Model load failed: ' + err.message, true);
  }
  $loading.classList.add('hidden');
}

(async () => { await initModel(); })();

// ══════════════════════════════════════════════════
//  Log rendering
// ══════════════════════════════════════════════════
log.onChange((entries) => {
  const count = entries.length;
  const setCount = (id) => { const el = document.getElementById(id); if (el) el.textContent = count; };
  setCount('logCount');
  setCount('logCountMain');
  document.getElementById('sLog').textContent = count;

  const html = entries.length === 0
    ? '<div class="empty-msg">No entries yet.</div>'
    : entries.slice().reverse().map(e => `
        <div class="det-item log-entry" style="border-left-color:${getColor(e.classId)}">
          <div class="det-swatch" style="background:${getColor(e.classId)}"></div>
          <span class="det-label">${e.className}</span>
          <span class="det-length">${e.lengthDisplay}</span>
          <span class="det-conf">${e.mode === 'auto' ? (e.confidence * 100).toFixed(0) + '%' : 'manual'}</span>
          <button class="log-del" data-id="${e.id}">✕</button>
        </div>
      `).join('');

  // Update both log lists
  ['logList', 'logListMain'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  });
});

// Delete entry handler (delegated)
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('log-del')) {
    log.removeEntry(parseInt(e.target.dataset.id));
  }
});

$btnClearLog.addEventListener('click', () => log.clearAll());

// ══════════════════════════════════════════════════
//  Mode switching
// ══════════════════════════════════════════════════
function setMode(mode) {
  currentMode = mode;

  // UI toggle
  $btnMode1.classList.toggle('active', mode === 'manual');
  $btnMode2.classList.toggle('active', mode === 'auto');
  $manualCtrls.classList.toggle('hidden', mode !== 'manual');
  $autoInfo.classList.toggle('hidden', mode !== 'auto');

  document.getElementById('sMode').textContent = mode === 'manual' ? 'M1' : 'M2';

  // Reset manual state on switch
  resetManualPoints();
}

$btnMode1.addEventListener('click', () => setMode('manual'));
$btnMode2.addEventListener('click', () => setMode('auto'));

// ══════════════════════════════════════════════════
//  Mode 1: Manual tap-to-measure
// ══════════════════════════════════════════════════
function resetManualPoints() {
  manualPoint1 = null;
  manualPoint2 = null;
  manualMeasuredLength = null;
  $manualStatus.textContent = 'Tap first point on damage';
  $manualClassRow.style.display = 'none';
  clearPointCanvas();
}

function clearPointCanvas() {
  $pointCanvas.width = window.innerWidth;
  $pointCanvas.height = window.innerHeight;
  $pointCtx.clearRect(0, 0, $pointCanvas.width, $pointCanvas.height);
}

function drawPoints() {
  clearPointCanvas();
  const ctx = $pointCtx;

  const drawDot = (p, label) => {
    ctx.beginPath();
    ctx.arc(p.screenX, p.screenY, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#00e5a0';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.screenX, p.screenY, 10, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = '600 13px "JetBrains Mono", monospace';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(label, p.screenX, p.screenY - 18);
  };

  if (manualPoint1) drawDot(manualPoint1, 'A');
  if (manualPoint2) drawDot(manualPoint2, 'B');

  if (manualPoint1 && manualPoint2) {
    // Draw line
    ctx.beginPath();
    ctx.moveTo(manualPoint1.screenX, manualPoint1.screenY);
    ctx.lineTo(manualPoint2.screenX, manualPoint2.screenY);
    ctx.strokeStyle = '#00e5a0';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw length label at midpoint
    if (manualMeasuredLength !== null) {
      const mx = (manualPoint1.screenX + manualPoint2.screenX) / 2;
      const my = (manualPoint1.screenY + manualPoint2.screenY) / 2;
      const label = formatDistance(manualMeasuredLength);

      ctx.font = '700 16px "JetBrains Mono", monospace';
      const tw = ctx.measureText(label).width + 14;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.beginPath();
      ctx.roundRect(mx - tw / 2, my - 24, tw, 28, 6);
      ctx.fill();

      ctx.fillStyle = '#00e5a0';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, mx, my - 10);
    }
  }
}

// Tap handler for Mode 1
$arOverlay.addEventListener('click', async (e) => {
  if (currentMode !== 'manual' || !arActive) return;

  // Ignore clicks on controls
  if (e.target.closest('.ar-hud') || e.target.closest('.ar-sidebar')) return;

  const sx = e.clientX;
  const sy = e.clientY;
  const nx = sx / window.innerWidth;
  const ny = sy / window.innerHeight;

  if (!manualPoint1) {
    // First point
    const world = await hitTestAtPoint(currentFrame, currentRefSpace, nx, ny);
    if (!world) { toast('No surface detected — try again', true); return; }
    manualPoint1 = { screenX: sx, screenY: sy, world };
    $manualStatus.textContent = 'Tap second point on damage';
    drawPoints();
  } else if (!manualPoint2) {
    // Second point
    const world = await hitTestAtPoint(currentFrame, currentRefSpace, nx, ny);
    if (!world) { toast('No surface detected — try again', true); return; }
    manualPoint2 = { screenX: sx, screenY: sy, world };
    manualMeasuredLength = distance3D(manualPoint1.world, manualPoint2.world);
    $manualStatus.textContent = `Length: ${formatDistance(manualMeasuredLength)}`;
    $manualClassRow.style.display = 'flex';
    drawPoints();
  }
});

$btnLogManual.addEventListener('click', () => {
  if (manualMeasuredLength === null) return;

  const classId = parseInt($manualClassSel.value);
  log.addEntry({
    mode: 'manual',
    classId,
    className: CLASS_NAMES[classId] ?? `class_${classId}`,
    lengthM: manualMeasuredLength,
    lengthDisplay: formatDistance(manualMeasuredLength),
  });

  toast(`Logged: ${CLASS_NAMES[classId]} — ${formatDistance(manualMeasuredLength)}`);
  resetManualPoints();
});

$btnResetPts.addEventListener('click', resetManualPoints);

// ══════════════════════════════════════════════════
//  Mode 2: Auto detection + measurement
// ══════════════════════════════════════════════════
$arThreshSlider.addEventListener('input', (e) => {
  threshold = e.target.value / 100;
  $arThreshVal.textContent = threshold.toFixed(2);
});

// Track which detections have already been logged (by bbox hash)
let loggedAutoHashes = new Set();

function bboxHash(det) {
  const [x, y, w, h] = det.bbox;
  // Quantize to avoid re-logging the same object every frame
  return `${det.classId}_${Math.round(x/20)}_${Math.round(y/20)}_${Math.round(w/20)}_${Math.round(h/20)}`;
}

async function processAutoDetections(dets, canvasW, canvasH) {
  for (const det of dets) {
    const hash = bboxHash(det);
    if (loggedAutoHashes.has(hash)) continue;

    // Measure diagonal via WebXR hit-test
    const diagM = await measureBBoxDiagonal(
      currentFrame, currentRefSpace,
      det.bbox, canvasW, canvasH
    );

    if (diagM !== null && diagM > 0.001) {
      loggedAutoHashes.add(hash);
      log.addEntry({
        mode: 'auto',
        classId: det.classId,
        className: det.className,
        confidence: det.confidence,
        lengthM: diagM,
        lengthDisplay: formatDistance(diagM),
        bbox: det.bbox,
      });
    }
  }
}

// ══════════════════════════════════════════════════
//  AR Session lifecycle
// ══════════════════════════════════════════════════
$btnStartAR.addEventListener('click', async () => {
  try {
    $btnStartAR.disabled = true;
    toast('Starting AR session…');

    const canvas = $arCanvas;
    const session = await startARSession(canvas);

    arActive = true;
    $arOverlay.classList.remove('hidden');
    document.getElementById('mainHeader').classList.add('hidden');
    document.getElementById('mainGrid').classList.add('hidden');

    $btnStopAR.disabled = false;
    document.getElementById('statusDot').classList.add('live');
    document.getElementById('statusLabel').textContent = 'AR Live';
    setMode(currentMode);

    loggedAutoHashes.clear();
    frames = 0;
    fpsTimes = [];

    // XR render loop (stays fast — no inference here)
    session.requestAnimationFrame(xrLoop);

    // Decoupled inference loop (runs every INFER_INTERVAL ms)
    inferenceLoop();

    session.addEventListener('end', () => {
      arActive = false;
      stopCameraStream();
      $arOverlay.classList.add('hidden');
      document.getElementById('mainHeader').classList.remove('hidden');
      document.getElementById('mainGrid').classList.remove('hidden');
      $btnStartAR.disabled = false;
      $btnStopAR.disabled = true;
      document.getElementById('statusDot').classList.remove('live');
      document.getElementById('statusLabel').textContent = 'Offline';
    });
  } catch (err) {
    console.error(err);
    toast('AR failed: ' + err.message, true);
    $btnStartAR.disabled = false;
  }
});

$btnStopAR.addEventListener('click', async () => {
  await endARSession();
});

// ══════════════════════════════════════════════════
//  XR Render Loop
// ══════════════════════════════════════════════════
let inferring = false;
let cameraStream = null;
let cameraVideo = null;
let lastDets = [];           // persist bounding boxes between inference runs
let inferLoopId = null;      // setTimeout id for decoupled inference
const INFER_INTERVAL = 300;  // ms between inference runs (~3 fps detection)

/**
 * Start a parallel camera stream for YOLO inference.
 * Low resolution to minimize preprocessing cost.
 */
async function startCameraStream() {
  if (cameraVideo) return;

  cameraVideo = document.createElement('video');
  cameraVideo.setAttribute('playsinline', '');
  cameraVideo.setAttribute('autoplay', '');
  cameraVideo.muted = true;
  cameraVideo.style.display = 'none';
  document.body.appendChild(cameraVideo);

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 320 }, height: { ideal: 240 } },
    });
    cameraVideo.srcObject = cameraStream;
    await cameraVideo.play();
  } catch (e) {
    console.warn('Parallel camera stream failed:', e);
    cameraVideo = null;
  }
}

function stopCameraStream() {
  if (inferLoopId) { clearTimeout(inferLoopId); inferLoopId = null; }
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  if (cameraVideo) {
    cameraVideo.remove();
    cameraVideo = null;
  }
  lastDets = [];
}

/**
 * Decoupled inference loop — runs independently from XR at INFER_INTERVAL.
 * This prevents YOLO from blocking the AR render loop.
 */
async function inferenceLoop() {
  if (!arActive || currentMode !== 'auto' || !isModelLoaded()) {
    inferLoopId = setTimeout(inferenceLoop, INFER_INTERVAL);
    return;
  }

  if (!cameraVideo) await startCameraStream();
  if (!cameraVideo || cameraVideo.readyState < 2) {
    inferLoopId = setTimeout(inferenceLoop, INFER_INTERVAL);
    return;
  }

  try {
    const vw = cameraVideo.videoWidth;
    const vh = cameraVideo.videoHeight;

    const t0 = performance.now();
    const dets = await detect(cameraVideo, threshold);
    const ms = (performance.now() - t0).toFixed(1);

    lastDets = dets;

    document.getElementById('sDet').textContent = dets.length;
    document.getElementById('sInf').textContent = ms;

    $autoStatus.textContent = dets.length
      ? `${dets.length} damage${dets.length > 1 ? 's' : ''} detected`
      : 'Scanning…';

    // Measure and log new detections via WebXR hit-test
    if (dets.length > 0 && currentFrame && currentRefSpace) {
      await processAutoDetections(dets, vw, vh);
    }
  } catch (e) {
    console.warn('Inference error:', e);
  }

  inferLoopId = setTimeout(inferenceLoop, INFER_INTERVAL);
}

/**
 * XR frame loop — stays fast, only draws bounding boxes from last inference.
 */
async function xrLoop(timestamp, frame) {
  const session = getSession();
  if (!session || !arActive) return;

  session.requestAnimationFrame(xrLoop);

  const refSpace = getRefSpace();
  currentFrame = frame;
  currentRefSpace = refSpace;
  onXRFrame(frame, refSpace);

  const pose = frame.getViewerPose(refSpace);
  if (!pose) return;

  // FPS tracking
  frames++;
  const now = performance.now();
  fpsTimes.push(now);
  fpsTimes = fpsTimes.filter(t => now - t < 1000);
  document.getElementById('arFps').textContent = fpsTimes.length;

  // Draw last detections every frame (cheap — just canvas 2D)
  if (currentMode === 'auto' && lastDets.length > 0 && cameraVideo) {
    drawAutoDetections(lastDets, cameraVideo.videoWidth, cameraVideo.videoHeight);
  } else if (currentMode === 'auto' && lastDets.length === 0) {
    clearPointCanvas();
  }
}

function drawAutoDetections(dets, sourceW, sourceH) {
  clearPointCanvas();
  const ctx = $pointCtx;
  const cw = $pointCanvas.width;
  const ch = $pointCanvas.height;

  // Map detection coords (in source video pixels) to screen overlay
  const sx = cw / sourceW;
  const sy = ch / sourceH;

  for (const det of dets) {
    const [x, y, w, h] = det.bbox;
    const dx = x * sx, dy = y * sy, dw = w * sx, dh = h * sy;
    const color = getColor(det.classId);

    // ── Main box ──
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([]);
    ctx.strokeRect(dx, dy, dw, dh);

    // ── Corner accents ──
    const cl = Math.min(16, dw * 0.25, dh * 0.25);
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = color;
    drawCorner(ctx, dx, dy, cl, 1, 1);
    drawCorner(ctx, dx + dw, dy, cl, -1, 1);
    drawCorner(ctx, dx, dy + dh, cl, 1, -1);
    drawCorner(ctx, dx + dw, dy + dh, cl, -1, -1);

    // ── Label with class + confidence ──
    const label = `${det.className} ${(det.confidence * 100).toFixed(0)}%`;
    ctx.font = '600 13px "JetBrains Mono", monospace';
    const tw = ctx.measureText(label).width + 12;
    const th = 22;

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(dx, dy - th - 2, tw, th, [4, 4, 0, 0]);
    ctx.fill();

    ctx.fillStyle = '#000';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, dx + 6, dy - th / 2 - 2);

    // ── Diagonal line (shows what's being measured) ──
    ctx.beginPath();
    ctx.moveTo(dx, dy);
    ctx.lineTo(dx + dw, dy + dh);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // ── Soft fill ──
    ctx.fillStyle = color + '15';
    ctx.fillRect(dx, dy, dw, dh);
  }
}

function drawCorner(ctx, x, y, len, dirX, dirY) {
  ctx.beginPath();
  ctx.moveTo(x, y + len * dirY);
  ctx.lineTo(x, y);
  ctx.lineTo(x + len * dirX, y);
  ctx.stroke();
}

// ══════════════════════════════════════════════════
//  Toast
// ══════════════════════════════════════════════════
function toast(msg, isErr = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' error' : '');
  setTimeout(() => el.classList.remove('show'), 3000);
}

// ══════════════════════════════════════════════════
//  Init
// ══════════════════════════════════════════════════
// Check AR support
(async () => {
  const supported = await isARSupported();
  if (!supported) {
    $btnStartAR.textContent = '⚠ AR Not Supported';
    $btnStartAR.disabled = true;
    toast('WebXR AR not supported on this device/browser', true);
  }
})();
