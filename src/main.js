import './style.css';
import { loadModel, detect, isModelLoaded } from './detector.js';
import { getColor, CLASS_NAMES } from './classes.js';
import {
  startARSession, endARSession, getSession, getRefSpace,
  onXRFrame, hitTestAtPoint, measureBBox, captureFrame,
  getCenterHitTest, dist3D, formatDistance, isARSupported,
  projectToScreen,
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

  <!-- ─── AR OVERLAY ─── -->
  <div id="ar-overlay" class="ar-overlay hidden">
    <canvas id="arCanvas"></canvas>
    <canvas id="pointCanvas"></canvas>

    <!-- Reticle — surface feedback -->
    <div class="reticle-wrap" id="reticleWrap">
      <div class="reticle" id="reticle">
        <div class="reticle-ring"></div>
        <div class="reticle-dot"></div>
      </div>
      <div class="surface-label" id="surfaceLabel">Searching for surface…</div>
    </div>

    <!-- Top bar -->
    <div class="ar-top">
      <button class="ar-close" id="btnCloseAR">✕</button>
      <div class="mode-pill">
        <button class="pill active" id="btnMode2">Auto</button>
        <button class="pill" id="btnMode1">Manual</button>
      </div>
      <div class="ar-fps-pill"><span id="arFps">0</span> fps</div>
    </div>

    <!-- Center action buttons -->
    <div class="ar-center-actions">
      <button class="ar-fab" id="btnCapture" title="Capture screenshot">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
      <button class="ar-fab ar-fab-primary" id="btnPlacePoint" title="Place measurement point">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </button>
    </div>

    <!-- Bottom — Auto (default) -->
    <div class="ar-bottom" id="autoBottom">
      <div class="ar-instruction" id="autoInstruction">Point camera at damaged area</div>
      <div class="ar-threshold">
        <span>Confidence</span>
        <input type="range" id="arThreshSlider" min="10" max="90" value="40" />
        <span id="arThreshVal">0.40</span>
      </div>
    </div>

    <!-- Bottom — Manual (fallback) -->
    <div class="ar-bottom hidden" id="manualBottom">
      <div class="ar-instruction" id="manualInstruction">Tap to place first point</div>
      <div class="ar-actions" id="manualActions" style="display:none">
        <select id="manualClassSelect" class="ar-select">
          ${CLASS_NAMES.map((c, i) => `<option value="${i}">${c}</option>`).join('')}
        </select>
        <button class="ar-btn ar-btn-accent" id="btnLogManual">Add to Log</button>
        <button class="ar-btn ar-btn-ghost" id="btnResetPoints">Redo</button>
      </div>
    </div>

    <!-- Floating log -->
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

  <!-- ─── LANDING ─── -->
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
        <div class="placeholder">
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
        <div class="det-scroll"><div class="det-list" id="logListMain">
          <div class="ar-log-empty">Start AR to begin.</div>
        </div></div>
      </div>
      <div class="panel">
        <div class="panel-head">Model</div>
        <div class="panel-body info-rows">
          <div class="row"><span>Architecture</span><span class="v">YOLOv8n</span></div>
          <div class="row"><span>Input</span><span class="v">640×640</span></div>
          <div class="row"><span>Status</span><span class="v" id="iStatus">Not loaded</span></div>
        </div>
      </div>
    </aside>
  </main>
`;

// ══════════════════════════════════════════════════
//  State
// ══════════════════════════════════════════════════
let currentMode = 'auto';        // auto-first
let arActive = false;
let threshold = 0.4;
let frames = 0, fpsTimes = [];
let surfaceDetected = false;
let currentFrame = null, currentRefSpace = null;

// Manual
let pt1 = null, pt2 = null, manualLen = null;

// Auto
let lastDets = [];
let inferLoopId = null;
const INFER_INTERVAL = 300;

// ══════════════════════════════════════════════════
//  Shorthand
// ══════════════════════════════════════════════════
const $ = id => document.getElementById(id);
const $overlay  = $('ar-overlay');
const $pCanvas  = $('pointCanvas');
const $pCtx     = $pCanvas.getContext('2d');
const $reticle  = $('reticle');
const $surfLbl  = $('surfaceLabel');
const $autoBot  = $('autoBottom');
const $manBot   = $('manualBottom');
const $autoInstr = $('autoInstruction');
const $manInstr  = $('manualInstruction');
const $manActs   = $('manualActions');
const $logBody   = $('arLogBody');
let logOpen = false;

// ══════════════════════════════════════════════════
//  Model load
// ══════════════════════════════════════════════════
(async () => {
  $('loadingScreen').classList.remove('hidden');
  $('loadingLabel').textContent = 'Loading YOLOv8n…';
  try {
    await loadModel('/best.onnx');
    $('iStatus').textContent = 'Ready';
    toast('Model loaded');
  } catch (e) {
    console.error(e);
    $('iStatus').textContent = 'Error';
    toast('Model failed: ' + e.message, true);
  }
  $('loadingScreen').classList.add('hidden');
})();

// ══════════════════════════════════════════════════
//  Log
// ══════════════════════════════════════════════════
log.onChange(entries => {
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
        </div>`).join('');
  [$('logList'), $('logListMain')].forEach(el => { if (el) el.innerHTML = html; });
});
document.addEventListener('click', e => { if (e.target.classList.contains('log-x')) log.removeEntry(+e.target.dataset.id); });
$('btnClearLog').addEventListener('click', () => { log.clearAll(); detTracker.clear(); });
$('btnToggleLog').addEventListener('click', () => { logOpen = !logOpen; $logBody.classList.toggle('open', logOpen); });

// ══════════════════════════════════════════════════
//  Mode switch
// ══════════════════════════════════════════════════
function setMode(mode) {
  currentMode = mode;
  $('btnMode1').classList.toggle('active', mode === 'manual');
  $('btnMode2').classList.toggle('active', mode === 'auto');
  $autoBot.classList.toggle('hidden', mode !== 'auto');
  $manBot.classList.toggle('hidden', mode !== 'manual');
  // Reticle only in manual
  $('reticleWrap').classList.toggle('hidden', mode !== 'manual');
  resetManual();
  if (mode === 'auto') lastDets = [];
}
$('btnMode2').addEventListener('click', () => setMode('auto'));
$('btnMode1').addEventListener('click', () => setMode('manual'));

// ══════════════════════════════════════════════════
//  Surface feedback
// ══════════════════════════════════════════════════
function updateSurface(detected) {
  if (detected === surfaceDetected) return;
  surfaceDetected = detected;
  $reticle.classList.toggle('found', detected);
  if (currentMode === 'manual' && !pt1) {
    $surfLbl.textContent = detected ? 'Surface found · Press + to place point' : 'Searching for surface…';
    $surfLbl.classList.toggle('ok', detected);
  }
}

// ══════════════════════════════════════════════════
//  Mode 1: Manual (fallback)
//  Points are stored as 3D world positions only.
//  Every XR frame, they're re-projected to screen coords
//  so they stick to their real-world location.
// ══════════════════════════════════════════════════
function resetManual() {
  pt1 = pt2 = null; manualLen = null;
  $manInstr.textContent = 'Aim reticle at damage · Press +';
  $manActs.style.display = 'none';
  clearCanvas();
}

function clearCanvas() {
  $pCanvas.width = window.innerWidth;
  $pCanvas.height = window.innerHeight;
  $pCtx.clearRect(0, 0, $pCanvas.width, $pCanvas.height);
}

/**
 * Draw manual measurement overlay.
 * Called every XR frame — re-projects 3D points to current screen position.
 */
function drawManual() {
  clearCanvas();
  const ctx = $pCtx;

  // Re-project world points to current screen coords
  const s1 = pt1 ? projectToScreen(pt1, currentFrame, currentRefSpace) : null;
  const s2 = pt2 ? projectToScreen(pt2, currentFrame, currentRefSpace) : null;

  const drawDot = (s) => {
    if (!s) return;
    // Outer glow
    ctx.beginPath(); ctx.arc(s.x, s.y, 14, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fill();
    // White ring
    ctx.beginPath(); ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
    // Green center
    ctx.beginPath(); ctx.arc(s.x, s.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#00e5a0'; ctx.fill();
  };

  if (s1) drawDot(s1);
  if (s2) drawDot(s2);

  if (s1 && s2) {
    // Dashed line between points
    ctx.beginPath(); ctx.moveTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]); ctx.stroke(); ctx.setLineDash([]);

    // Measurement pill at midpoint
    if (manualLen !== null) {
      const mx = (s1.x + s2.x) / 2, my = (s1.y + s2.y) / 2;
      const t = formatDistance(manualLen);
      ctx.font = '700 18px -apple-system, sans-serif';
      const tw = ctx.measureText(t).width + 24, th = 34;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.beginPath(); ctx.roundRect(mx - tw / 2, my - th / 2, tw, th, th / 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(mx - tw / 2, my - th / 2, tw, th, th / 2); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(t, mx, my);
    }
  }
}

// ── Plus button: place point at reticle (screen center) ──
$('btnPlacePoint').addEventListener('click', async () => {
  if (currentMode !== 'manual' || !arActive) return;
  if (!surfaceDetected) { toast('No surface — move device', true); return; }

  if (!pt1) {
    const w = await hitTestAtPoint(currentFrame, currentRefSpace, 0.5, 0.5);
    if (!w) { toast('Hit-test failed', true); return; }
    pt1 = w; // store only the 3D world position {x,y,z}
    $manInstr.textContent = 'Move to second point · Press +';
    $surfLbl.textContent = '';
  } else if (!pt2) {
    const w = await hitTestAtPoint(currentFrame, currentRefSpace, 0.5, 0.5);
    if (!w) { toast('Hit-test failed', true); return; }
    pt2 = w; // store only the 3D world position {x,y,z}
    manualLen = dist3D(pt1, pt2);
    $manInstr.textContent = formatDistance(manualLen);
    $manActs.style.display = 'flex';
  }
});

// ── Capture screenshot ──
$('btnCapture').addEventListener('click', () => {
  if (!arActive) return;

  // Composite: grab the XR canvas + overlay canvas
  const w = window.innerWidth, h = window.innerHeight;
  const cap = document.createElement('canvas');
  cap.width = w; cap.height = h;
  const cx = cap.getContext('2d');

  // Draw the AR canvas (WebGL)
  const arC = $('arCanvas');
  try { cx.drawImage(arC, 0, 0, w, h); } catch (e) { /* may fail due to XR */ }

  // Draw the point/bbox overlay on top
  cx.drawImage($pCanvas, 0, 0, w, h);

  // Draw a timestamp
  cx.font = '600 12px -apple-system, sans-serif';
  cx.fillStyle = 'rgba(255,255,255,0.6)';
  cx.textAlign = 'right';
  cx.fillText(new Date().toLocaleString(), w - 12, h - 12);

  // Download
  const a = document.createElement('a');
  a.download = `damage-capture-${Date.now()}.png`;
  a.href = cap.toDataURL('image/png');
  a.click();

  toast('Screenshot saved');
});

$('btnLogManual').addEventListener('click', () => {
  if (manualLen === null) return;
  const cid = +$('manualClassSelect').value;
  log.addEntry({ mode: 'manual', classId: cid, className: CLASS_NAMES[cid] ?? `class_${cid}`, lengthM: manualLen, lengthDisplay: formatDistance(manualLen) });
  toast(`Logged: ${CLASS_NAMES[cid]} — ${formatDistance(manualLen)}`);
  resetManual();
});
$('btnResetPoints').addEventListener('click', resetManual);

// ══════════════════════════════════════════════════
//  Mode 2: Auto — YOLO first, then WebXR measures
//
//  Detections are LIVE and EPHEMERAL:
//  - Each inference cycle replaces all previous boxes
//  - If YOLO doesn't see damage → boxes disappear
//  - Stable detections (seen 2+ cycles) get measured & logged
//  - Moving away = boxes gone instantly
// ══════════════════════════════════════════════════
$('arThreshSlider').addEventListener('input', e => {
  threshold = e.target.value / 100;
  $('arThreshVal').textContent = threshold.toFixed(2);
});

// Track detection stability: hash → { count, logged, measurement }
let detTracker = new Map();

function bboxHash(d) {
  const [x, y, w, h] = d.bbox;
  // Coarser quantization so slight jitter doesn't create new entries
  return `${d.classId}_${Math.round(x / 30)}_${Math.round(y / 30)}_${Math.round(w / 30)}_${Math.round(h / 30)}`;
}

/**
 * Process fresh detections: track stability, measure & log stable ones.
 */
async function processDetections(dets, camW, camH) {
  // Build set of current hashes
  const currentHashes = new Set(dets.map(d => bboxHash(d)));

  // Remove stale entries (no longer detected)
  for (const [hash] of detTracker) {
    if (!currentHashes.has(hash)) detTracker.delete(hash);
  }

  // Update/create tracker entries
  for (const det of dets) {
    const hash = bboxHash(det);
    const existing = detTracker.get(hash);

    if (existing) {
      existing.count++;
      existing.det = det; // update with latest bbox

      // Auto-log after 2 stable cycles if not yet logged
      if (existing.count >= 2 && !existing.logged && currentFrame && currentRefSpace) {
        const lenM = await measureBBox(currentFrame, currentRefSpace, det.bbox, camW, camH);
        if (lenM !== null) {
          existing.logged = true;
          existing.measurement = formatDistance(lenM);
          log.addEntry({
            mode: 'auto',
            classId: det.classId,
            className: det.className,
            confidence: det.confidence,
            lengthM: lenM,
            lengthDisplay: formatDistance(lenM),
            bbox: det.bbox,
          });
          toast(`${det.className} — ${formatDistance(lenM)}`);
        }
      }
    } else {
      detTracker.set(hash, { count: 1, logged: false, measurement: null, det });
    }
  }
}

// ── No parallel camera — capture directly from XR framebuffer ──
let lastDetSource = { w: 640, h: 480 };

function stopCamera() {
  if (inferLoopId) { clearTimeout(inferLoopId); inferLoopId = null; }
  lastDets = [];
  detTracker.clear();
}

/**
 * Decoupled inference loop.
 * Captures the AR camera view from the XR framebuffer,
 * runs YOLO on it, updates detections.
 */
async function inferLoop() {
  if (!arActive || currentMode !== 'auto' || !isModelLoaded()) {
    if (currentMode !== 'auto') { lastDets = []; detTracker.clear(); }
    inferLoopId = setTimeout(inferLoop, INFER_INTERVAL); return;
  }

  // Capture current AR view from framebuffer
  const captured = captureFrame(currentFrame, currentRefSpace);
  if (!captured) {
    inferLoopId = setTimeout(inferLoop, INFER_INTERVAL); return;
  }

  try {
    const { canvas, width, height } = captured;
    const dets = await detect(canvas, threshold);

    lastDets = dets;
    lastDetSource = { w: width, h: height };

    $autoInstr.textContent = dets.length
      ? `${dets.length} damage${dets.length > 1 ? 's' : ''} detected`
      : 'Scanning for damage…';

    await processDetections(dets, width, height);
  } catch (e) { console.warn('Infer error:', e); }

  inferLoopId = setTimeout(inferLoop, INFER_INTERVAL);
}

// ── Draw bounding boxes (only what YOLO currently sees) ──
function drawAuto(dets, sw, sh) {
  clearCanvas();
  const ctx = $pCtx;
  const cw = $pCanvas.width, ch = $pCanvas.height;
  const rx = cw / sw, ry = ch / sh;

  for (const d of dets) {
    const [x, y, w, h] = d.bbox;
    const dx = x * rx, dy = y * ry, dw = w * rx, dh = h * ry;
    const col = getColor(d.classId);
    const hash = bboxHash(d);
    const tracker = detTracker.get(hash);

    // Box
    ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.setLineDash([]);
    ctx.strokeRect(dx, dy, dw, dh);

    // Corners
    const cl = Math.min(14, dw * .22, dh * .22);
    ctx.lineWidth = 3.5;
    corner(ctx, dx, dy, cl, 1, 1);
    corner(ctx, dx + dw, dy, cl, -1, 1);
    corner(ctx, dx, dy + dh, cl, 1, -1);
    corner(ctx, dx + dw, dy + dh, cl, -1, -1);

    // Label pill
    const label = `${d.className} ${(d.confidence * 100).toFixed(0)}%`;
    ctx.font = '600 12px -apple-system, sans-serif';
    const tw = ctx.measureText(label).width + 14, th = 24;
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.roundRect(dx, dy - th - 4, tw, th, 6); ctx.fill();
    ctx.fillStyle = '#000'; ctx.textBaseline = 'middle';
    ctx.fillText(label, dx + 7, dy - th / 2 - 4);

    // Soft fill
    ctx.fillStyle = col + '15';
    ctx.fillRect(dx, dy, dw, dh);

    // Show measurement if this detection has been measured
    if (tracker && tracker.measurement) {
      const mx = dx + dw / 2, my = dy + dh / 2;
      const t = tracker.measurement;
      ctx.font = '700 14px -apple-system, sans-serif';
      const mtw = ctx.measureText(t).width + 16, mth = 26;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.beginPath(); ctx.roundRect(mx - mtw / 2, my - mth / 2, mtw, mth, mth / 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(mx - mtw / 2, my - mth / 2, mtw, mth, mth / 2); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(t, mx, my);
      ctx.textAlign = 'start';
    } else if (tracker && tracker.count === 1) {
      // First sighting — show "measuring..." indicator
      const mx = dx + dw / 2, my = dy + dh / 2;
      ctx.font = '500 11px -apple-system, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('measuring…', mx, my);
      ctx.textAlign = 'start';
    }
  }
}

function corner(ctx, x, y, l, dx, dy) {
  ctx.beginPath();
  ctx.moveTo(x, y + l * dy); ctx.lineTo(x, y); ctx.lineTo(x + l * dx, y);
  ctx.stroke();
}

// ══════════════════════════════════════════════════
//  AR Session
// ══════════════════════════════════════════════════
$('btnStartAR').addEventListener('click', async () => {
  try {
    $('btnStartAR').disabled = true;
    toast('Starting AR…');
    const session = await startARSession($('arCanvas'));
    arActive = true;
    $overlay.classList.remove('hidden');
    $('mainHeader').classList.add('hidden');
    $('mainGrid').classList.add('hidden');
    setMode(currentMode);
    detTracker.clear();
    frames = 0; fpsTimes = [];
    surfaceDetected = false; updateSurface(false);

    session.requestAnimationFrame(xrLoop);
    inferLoop();

    session.addEventListener('end', () => {
      arActive = false; stopCamera();
      $overlay.classList.add('hidden');
      $('mainHeader').classList.remove('hidden');
      $('mainGrid').classList.remove('hidden');
      $('btnStartAR').disabled = false;
    });
  } catch (e) {
    console.error(e);
    toast('AR failed: ' + e.message, true);
    $('btnStartAR').disabled = false;
  }
});

$('btnCloseAR').addEventListener('click', () => endARSession());

// ══════════════════════════════════════════════════
//  XR Loop — lightweight: surface check + draw boxes
// ══════════════════════════════════════════════════
function xrLoop(ts, frame) {
  const session = getSession();
  if (!session || !arActive) return;
  session.requestAnimationFrame(xrLoop);

  const ref = getRefSpace();
  currentFrame = frame; currentRefSpace = ref;
  onXRFrame();

  const pose = frame.getViewerPose(ref);
  if (!pose) return;

  // FPS
  frames++;
  const now = performance.now();
  fpsTimes.push(now);
  fpsTimes = fpsTimes.filter(t => now - t < 1000);
  $('arFps').textContent = fpsTimes.length;

  // Surface detection
  updateSurface(getCenterHitTest(frame, ref) !== null);

  // Draw based on mode
  if (currentMode === 'manual' && (pt1 || pt2)) {
    drawManual();
  } else if (currentMode === 'auto' && lastDets.length > 0) {
    drawAuto(lastDets, lastDetSource.w, lastDetSource.h);
  } else {
    clearCanvas();
  }
}

// ══════════════════════════════════════════════════
//  Utils
// ══════════════════════════════════════════════════
function toast(msg, err = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (err ? ' error' : '');
  setTimeout(() => el.classList.remove('show'), 3000);
}

(async () => {
  if (!(await isARSupported())) {
    $('btnStartAR').textContent = 'AR Not Supported';
    $('btnStartAR').disabled = true;
    toast('WebXR AR not available', true);
  }
})();
