import './style.css';
import { loadModel, detect, isModelLoaded } from './detector.js';
import { getColor, CLASS_NAMES } from './classes.js';
import {
  startARSession, endARSession, getSession, getRefSpace,
  onXRFrame, hitTestAtPoint, measureBBoxDiagonal,
  getCenterHitTest, distance3D, formatDistance, isARSupported,
} from './ar.js';
import * as log from './log.js';

// ══════════════════════════════════════════════════
//  DOM
// ══════════════════════════════════════════════════
document.getElementById('app').innerHTML = `
  <div class="loading-screen" id="loadingScreen">
    <div class="spinner"></div>
    <div class="loading-label" id="loadingLabel">Initializing…</div>
  </div>
  <div class="toast" id="toast"></div>

  <!-- ─── AR OVERLAY (DOM overlay during XR) ─── -->
  <div id="ar-overlay" class="ar-overlay hidden">
    <canvas id="arCanvas"></canvas>
    <canvas id="pointCanvas"></canvas>

    <!-- Center reticle (Measure-app style) -->
    <div class="reticle-wrap" id="reticleWrap">
      <div class="reticle" id="reticle">
        <div class="reticle-ring"></div>
        <div class="reticle-dot"></div>
      </div>
      <div class="surface-label" id="surfaceLabel">Move device to detect surface</div>
    </div>

    <!-- Top bar -->
    <div class="ar-top">
      <button class="ar-close" id="btnCloseAR">✕</button>
      <div class="mode-pill">
        <button class="pill active" id="btnMode1">Manual</button>
        <button class="pill" id="btnMode2">Auto</button>
      </div>
      <div class="ar-fps-pill"><span id="arFps">0</span> fps</div>
    </div>

    <!-- Bottom bar — Mode 1 -->
    <div class="ar-bottom" id="manualBottom">
      <div class="ar-instruction" id="manualInstruction">Point at surface · Tap to place first point</div>
      <div class="ar-actions" id="manualActions" style="display:none">
        <select id="manualClassSelect" class="ar-select">
          ${CLASS_NAMES.map((c, i) => `<option value="${i}">${c}</option>`).join('')}
        </select>
        <button class="ar-btn ar-btn-accent" id="btnLogManual">Add to Log</button>
        <button class="ar-btn ar-btn-ghost" id="btnResetPoints">Redo</button>
      </div>
    </div>

    <!-- Bottom bar — Mode 2 -->
    <div class="ar-bottom hidden" id="autoBottom">
      <div class="ar-instruction" id="autoInstruction">Scanning for damage…</div>
      <div class="ar-threshold">
        <span>Confidence</span>
        <input type="range" id="arThreshSlider" min="10" max="90" value="40" />
        <span id="arThreshVal">0.40</span>
      </div>
    </div>

    <!-- Floating log (collapsible) -->
    <div class="ar-log" id="arLog">
      <button class="ar-log-toggle" id="btnToggleLog">
        Damage Log <span class="log-badge" id="logCount">0</span>
      </button>
      <div class="ar-log-body" id="arLogBody">
        <div class="ar-log-list" id="logList">
          <div class="ar-log-empty">No entries yet</div>
        </div>
      </div>
    </div>
  </div>

  <!-- ─── LANDING PAGE (non-AR) ─── -->
  <header class="app-header" id="mainHeader">
    <div class="logo">
      <div class="logo-mark">◎</div>
      <div class="logo-text">DAMAGE<span>.detect</span></div>
    </div>
    <div class="header-right">
      <div class="badge"><div class="dot" id="statusDot"></div><span id="statusLabel">Offline</span></div>
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
        <button class="btn btn-primary" id="btnStartAR">▶ Start AR Session</button>
        <button class="btn" id="btnClearLog">Clear Log</button>
      </div>
    </section>
    <aside class="sidebar">
      <div class="panel grow">
        <div class="panel-head">Damage Log <span class="count" id="logCountMain">0</span></div>
        <div class="det-scroll">
          <div class="det-list" id="logListMain">
            <div class="ar-log-empty">No entries yet.<br/>Start AR to begin.</div>
          </div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head">Model</div>
        <div class="panel-body info-rows">
          <div class="row"><span>Architecture</span><span class="v">YOLOv8n</span></div>
          <div class="row"><span>Input</span><span class="v">640 × 640</span></div>
          <div class="row"><span>Status</span><span class="v" id="iStatus">Not loaded</span></div>
        </div>
      </div>
    </aside>
  </main>
`;

// ══════════════════════════════════════════════════
//  State
// ══════════════════════════════════════════════════
let currentMode = 'manual';
let arActive = false;
let threshold = 0.4;
let frames = 0;
let fpsTimes = [];
let surfaceDetected = false;

// Mode 1
let manualPoint1 = null;
let manualPoint2 = null;
let manualMeasuredLength = null;

// XR
let currentFrame = null;
let currentRefSpace = null;

// Mode 2
let lastDets = [];
let inferLoopId = null;
let cameraStream = null;
let cameraVideo = null;
const INFER_INTERVAL = 300;
let loggedAutoHashes = new Set();

// ══════════════════════════════════════════════════
//  Element refs
// ══════════════════════════════════════════════════
const $ = (id) => document.getElementById(id);
const $arOverlay    = $('ar-overlay');
const $arCanvas     = $('arCanvas');
const $pointCanvas  = $('pointCanvas');
const $pointCtx     = $pointCanvas.getContext('2d');
const $reticle      = $('reticle');
const $reticleWrap  = $('reticleWrap');
const $surfaceLabel = $('surfaceLabel');
const $manualBottom = $('manualBottom');
const $autoBottom   = $('autoBottom');
const $manualInstr  = $('manualInstruction');
const $manualActions = $('manualActions');
const $autoInstr    = $('autoInstruction');
const $btnMode1     = $('btnMode1');
const $btnMode2     = $('btnMode2');
const $loading      = $('loadingScreen');
const $loadLabel    = $('loadingLabel');
const $logBody      = $('arLogBody');
let logOpen = false;

// ══════════════════════════════════════════════════
//  Model
// ══════════════════════════════════════════════════
(async () => {
  $loading.classList.remove('hidden');
  $loadLabel.textContent = 'Loading YOLOv8n damage model…';
  try {
    await loadModel('/best.onnx');
    $('iStatus').textContent = 'Ready';
    toast('Model loaded');
  } catch (e) {
    console.error(e);
    $('iStatus').textContent = 'Error';
    toast('Model failed: ' + e.message, true);
  }
  $loading.classList.add('hidden');
})();

// ══════════════════════════════════════════════════
//  Log rendering
// ══════════════════════════════════════════════════
log.onChange((entries) => {
  const n = entries.length;
  [$('logCount'), $('logCountMain')].forEach(el => { if (el) el.textContent = n; });

  const html = !n
    ? '<div class="ar-log-empty">No entries yet</div>'
    : entries.slice().reverse().map(e => `
        <div class="log-row" style="border-left-color:${getColor(e.classId)}">
          <div class="log-swatch" style="background:${getColor(e.classId)}"></div>
          <span class="log-name">${e.className}</span>
          <span class="log-len">${e.lengthDisplay}</span>
          <span class="log-tag">${e.mode === 'auto' ? (e.confidence * 100).toFixed(0) + '%' : 'M'}</span>
          <button class="log-x" data-id="${e.id}">✕</button>
        </div>
      `).join('');

  [$('logList'), $('logListMain')].forEach(el => { if (el) el.innerHTML = html; });
});

document.addEventListener('click', (e) => {
  if (e.target.classList.contains('log-x')) log.removeEntry(+e.target.dataset.id);
});
$('btnClearLog').addEventListener('click', () => log.clearAll());

// Toggle log panel
$('btnToggleLog').addEventListener('click', () => {
  logOpen = !logOpen;
  $logBody.classList.toggle('open', logOpen);
});

// ══════════════════════════════════════════════════
//  Mode switching
// ══════════════════════════════════════════════════
function setMode(mode) {
  currentMode = mode;
  $btnMode1.classList.toggle('active', mode === 'manual');
  $btnMode2.classList.toggle('active', mode === 'auto');
  $manualBottom.classList.toggle('hidden', mode !== 'manual');
  $autoBottom.classList.toggle('hidden', mode !== 'auto');

  // Show reticle only in manual mode
  $reticleWrap.classList.toggle('hidden', mode !== 'manual');

  resetManualPoints();
  if (mode === 'auto') lastDets = [];
}

$btnMode1.addEventListener('click', () => setMode('manual'));
$btnMode2.addEventListener('click', () => setMode('auto'));

// ══════════════════════════════════════════════════
//  Surface detection feedback
// ══════════════════════════════════════════════════
function updateSurfaceState(detected) {
  if (detected === surfaceDetected) return;
  surfaceDetected = detected;

  $reticle.classList.toggle('found', detected);

  if (currentMode === 'manual') {
    if (!manualPoint1) {
      $surfaceLabel.textContent = detected
        ? 'Surface detected · Tap to place point'
        : 'Move device to detect surface';
      $surfaceLabel.classList.toggle('surface-ok', detected);
    }
  }
}

// ══════════════════════════════════════════════════
//  Mode 1: Manual
// ══════════════════════════════════════════════════
function resetManualPoints() {
  manualPoint1 = null;
  manualPoint2 = null;
  manualMeasuredLength = null;
  $manualInstr.textContent = surfaceDetected
    ? 'Surface detected · Tap to place first point'
    : 'Point at surface · Tap to place first point';
  $manualActions.style.display = 'none';
  clearPointCanvas();
}

function clearPointCanvas() {
  $pointCanvas.width = window.innerWidth;
  $pointCanvas.height = window.innerHeight;
  $pointCtx.clearRect(0, 0, $pointCanvas.width, $pointCanvas.height);
}

function drawManualOverlay() {
  clearPointCanvas();
  const ctx = $pointCtx;

  const drawDot = (p, label) => {
    // Outer glow
    ctx.beginPath();
    ctx.arc(p.screenX, p.screenY, 14, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fill();
    // White ring
    ctx.beginPath();
    ctx.arc(p.screenX, p.screenY, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    // Inner dot
    ctx.beginPath();
    ctx.arc(p.screenX, p.screenY, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#00e5a0';
    ctx.fill();
  };

  if (manualPoint1) drawDot(manualPoint1, 'A');
  if (manualPoint2) drawDot(manualPoint2, 'B');

  if (manualPoint1 && manualPoint2) {
    // Dashed line
    ctx.beginPath();
    ctx.moveTo(manualPoint1.screenX, manualPoint1.screenY);
    ctx.lineTo(manualPoint2.screenX, manualPoint2.screenY);
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Measurement pill at midpoint
    if (manualMeasuredLength !== null) {
      const mx = (manualPoint1.screenX + manualPoint2.screenX) / 2;
      const my = (manualPoint1.screenY + manualPoint2.screenY) / 2;
      const text = formatDistance(manualMeasuredLength);

      ctx.font = '700 18px -apple-system, "SF Pro Display", sans-serif';
      const tw = ctx.measureText(text).width + 24;
      const th = 34;

      // Pill background
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.beginPath();
      ctx.roundRect(mx - tw / 2, my - th / 2, tw, th, th / 2);
      ctx.fill();

      // Border
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(mx - tw / 2, my - th / 2, tw, th, th / 2);
      ctx.stroke();

      // Text
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, mx, my);
    }
  }
}

// Tap handler
$arOverlay.addEventListener('click', async (e) => {
  if (currentMode !== 'manual' || !arActive) return;
  if (e.target.closest('.ar-top') || e.target.closest('.ar-bottom') || e.target.closest('.ar-log')) return;
  if (!surfaceDetected) { toast('No surface detected — move device', true); return; }

  const sx = e.clientX;
  const sy = e.clientY;
  const nx = sx / window.innerWidth;
  const ny = sy / window.innerHeight;

  if (!manualPoint1) {
    const world = await hitTestAtPoint(currentFrame, currentRefSpace, nx, ny);
    if (!world) { toast('Hit-test failed — try again', true); return; }
    manualPoint1 = { screenX: sx, screenY: sy, world };
    $manualInstr.textContent = 'Tap to place second point';
    $surfaceLabel.textContent = 'Tap second point';
    drawManualOverlay();
  } else if (!manualPoint2) {
    const world = await hitTestAtPoint(currentFrame, currentRefSpace, nx, ny);
    if (!world) { toast('Hit-test failed — try again', true); return; }
    manualPoint2 = { screenX: sx, screenY: sy, world };
    manualMeasuredLength = distance3D(manualPoint1.world, manualPoint2.world);
    $manualInstr.textContent = formatDistance(manualMeasuredLength);
    $surfaceLabel.textContent = '';
    $manualActions.style.display = 'flex';
    drawManualOverlay();
  }
});

$('btnLogManual').addEventListener('click', () => {
  if (manualMeasuredLength === null) return;
  const classId = +$('manualClassSelect').value;
  log.addEntry({
    mode: 'manual', classId,
    className: CLASS_NAMES[classId] ?? `class_${classId}`,
    lengthM: manualMeasuredLength,
    lengthDisplay: formatDistance(manualMeasuredLength),
  });
  toast(`Logged: ${CLASS_NAMES[classId]} — ${formatDistance(manualMeasuredLength)}`);
  resetManualPoints();
});

$('btnResetPoints').addEventListener('click', resetManualPoints);

// ══════════════════════════════════════════════════
//  Mode 2: Auto
// ══════════════════════════════════════════════════
$('arThreshSlider').addEventListener('input', (e) => {
  threshold = e.target.value / 100;
  $('arThreshVal').textContent = threshold.toFixed(2);
});

function bboxHash(det) {
  const [x, y, w, h] = det.bbox;
  return `${det.classId}_${Math.round(x / 20)}_${Math.round(y / 20)}_${Math.round(w / 20)}_${Math.round(h / 20)}`;
}

async function processAutoDetections(dets, cw, ch) {
  for (const det of dets) {
    const hash = bboxHash(det);
    if (loggedAutoHashes.has(hash)) continue;
    const diagM = await measureBBoxDiagonal(currentFrame, currentRefSpace, det.bbox, cw, ch);
    if (diagM !== null && diagM > 0.001) {
      loggedAutoHashes.add(hash);
      log.addEntry({
        mode: 'auto', classId: det.classId, className: det.className,
        confidence: det.confidence, lengthM: diagM,
        lengthDisplay: formatDistance(diagM), bbox: det.bbox,
      });
    }
  }
}

// ── Parallel camera ──
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
    console.warn('Camera stream failed:', e);
    cameraVideo = null;
  }
}

function stopCameraStream() {
  if (inferLoopId) { clearTimeout(inferLoopId); inferLoopId = null; }
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  if (cameraVideo) { cameraVideo.remove(); cameraVideo = null; }
  lastDets = [];
}

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
    const dets = await detect(cameraVideo, threshold);
    lastDets = dets;
    $autoInstr.textContent = dets.length
      ? `${dets.length} damage${dets.length > 1 ? 's' : ''} found`
      : 'Scanning for damage…';
    if (dets.length > 0 && currentFrame && currentRefSpace) {
      await processAutoDetections(dets, vw, vh);
    }
  } catch (e) { console.warn('Inference error:', e); }
  inferLoopId = setTimeout(inferenceLoop, INFER_INTERVAL);
}

function drawAutoDetections(dets, sourceW, sourceH) {
  clearPointCanvas();
  const ctx = $pointCtx;
  const cw = $pointCanvas.width;
  const ch = $pointCanvas.height;
  const sx = cw / sourceW;
  const sy = ch / sourceH;

  for (const det of dets) {
    const [x, y, w, h] = det.bbox;
    const dx = x * sx, dy = y * sy, dw = w * sx, dh = h * sy;
    const color = getColor(det.classId);

    // Box with rounded feel
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([]);
    ctx.strokeRect(dx, dy, dw, dh);

    // Corner accents
    const cl = Math.min(16, dw * 0.25, dh * 0.25);
    ctx.lineWidth = 3.5;
    drawCorner(ctx, dx, dy, cl, 1, 1);
    drawCorner(ctx, dx + dw, dy, cl, -1, 1);
    drawCorner(ctx, dx, dy + dh, cl, 1, -1);
    drawCorner(ctx, dx + dw, dy + dh, cl, -1, -1);

    // Label pill
    const label = `${det.className} ${(det.confidence * 100).toFixed(0)}%`;
    ctx.font = '600 12px -apple-system, "SF Pro Text", sans-serif';
    const tw = ctx.measureText(label).width + 14;
    const th = 24;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(dx, dy - th - 4, tw, th, 6);
    ctx.fill();
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, dx + 7, dy - th / 2 - 4);

    // Diagonal dashed line
    ctx.beginPath();
    ctx.moveTo(dx, dy);
    ctx.lineTo(dx + dw, dy + dh);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Fill
    ctx.fillStyle = color + '12';
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
//  AR Session
// ══════════════════════════════════════════════════
$('btnStartAR').addEventListener('click', async () => {
  try {
    $('btnStartAR').disabled = true;
    toast('Starting AR…');
    const session = await startARSession($arCanvas);
    arActive = true;
    $arOverlay.classList.remove('hidden');
    $('mainHeader').classList.add('hidden');
    $('mainGrid').classList.add('hidden');
    setMode(currentMode);
    loggedAutoHashes.clear();
    frames = 0; fpsTimes = [];
    surfaceDetected = false;
    updateSurfaceState(false);

    session.requestAnimationFrame(xrLoop);
    inferenceLoop();

    session.addEventListener('end', () => {
      arActive = false;
      stopCameraStream();
      $arOverlay.classList.add('hidden');
      $('mainHeader').classList.remove('hidden');
      $('mainGrid').classList.remove('hidden');
      $('btnStartAR').disabled = false;
      $('statusDot').classList.remove('live');
      $('statusLabel').textContent = 'Offline';
    });
  } catch (e) {
    console.error(e);
    toast('AR failed: ' + e.message, true);
    $('btnStartAR').disabled = false;
  }
});

$('btnCloseAR').addEventListener('click', () => endARSession());

// ══════════════════════════════════════════════════
//  XR Loop — fast, only draws + checks surface
// ══════════════════════════════════════════════════
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

  // FPS
  frames++;
  const now = performance.now();
  fpsTimes.push(now);
  fpsTimes = fpsTimes.filter(t => now - t < 1000);
  $('arFps').textContent = fpsTimes.length;

  // ── Surface detection via center hit-test ──
  const centerHit = getCenterHitTest(frame, refSpace);
  updateSurfaceState(centerHit !== null);

  // ── Draw last auto detections ──
  if (currentMode === 'auto' && cameraVideo) {
    if (lastDets.length > 0) {
      drawAutoDetections(lastDets, cameraVideo.videoWidth, cameraVideo.videoHeight);
    } else {
      clearPointCanvas();
    }
  }
}

// ══════════════════════════════════════════════════
//  Utils
// ══════════════════════════════════════════════════
function toast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' error' : '');
  setTimeout(() => el.classList.remove('show'), 3000);
}

// AR support check
(async () => {
  if (!(await isARSupported())) {
    $('btnStartAR').textContent = 'AR Not Supported';
    $('btnStartAR').disabled = true;
    toast('WebXR AR not available on this device', true);
  }
})();
