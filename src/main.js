import './style.css';
import { loadModel, detect, isModelLoaded } from './detector.js';
import { drawDetections } from './renderer.js';
import { getColor, CLASS_NAMES } from './classes.js';
import { estimateRepairCosts } from './cost-estimator.js';
import { searchVendors } from './vendor-search.js';

// Damage types that get cost estimates vs vendor search
const REPAIR_TYPES = new Set(['dent', 'scratch', 'crack']);
const PARTS_TYPES  = new Set(['glass_shatter', 'tire_flat', 'lamp_broken']);

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
      <div class="badge"><div class="dot" id="statusDot"></div><span id="statusLabel">Offline</span></div>
      <div class="badge"><span id="fpsVal">0</span>&thinsp;FPS</div>
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
          <div style="display:flex;gap:6px;">
            <button class="log-clear-btn" id="btnEstimateAll">$ Estimate All</button>
            <button class="log-clear-btn" id="btnClearLog">Clear</button>
          </div>
        </div>
        <div class="det-scroll">
          <div class="det-list" id="logList">
            <div class="empty-msg">Tap a live detection to log it.</div>
          </div>
        </div>
      </div>

      <!-- Cost / Vendor results panel -->
      <div class="panel" id="estimatePanel" style="display:none;">
        <div class="panel-head">
          Cost Estimate
          <button class="log-clear-btn" id="btnCloseEstimate">✕</button>
        </div>
        <div class="panel-body" id="estimateBody"></div>
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
let damageLog = [];
let logNextId = 1;

// Live detections with persistence (3 second TTL)
const LIVE_TTL = 3000;
let liveDets = [];
let currentDets = [];

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

// Threshold
$('threshSlider').addEventListener('input', (e) => {
  threshold = e.target.value / 100;
  $('threshVal').textContent = threshold.toFixed(2);
});

// Capture
$('btnCapture').addEventListener('click', () => {
  const c = document.createElement('canvas');
  c.width = $overlay.width; c.height = $overlay.height;
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
//  Damage Log rendering
// ══════════════════════════════════════════════════
function renderLog() {
  $('logCount').textContent = damageLog.length;
  const list = $('logList');
  if (!damageLog.length) {
    list.innerHTML = '<div class="empty-msg">Tap a live detection to log it.</div>';
    return;
  }
  list.innerHTML = damageLog.slice().reverse().map(e => {
    const isRepair = REPAIR_TYPES.has(e.className);
    const isParts = PARTS_TYPES.has(e.className);
    const costHtml = e.estimate
      ? `<span class="det-cost">$${e.estimate.estimatedCost}</span>`
      : '';
    const vendorHtml = e.vendors
      ? `<span class="det-cost">${e.vendors.length ? '$' + e.vendors[0].price : 'Est. $' + e.vendorFallback?.min + '–' + e.vendorFallback?.max}</span>`
      : '';

    return `
      <div class="det-item log-entry" style="border-left-color:${getColor(e.classId)}" data-log-id="${e.id}">
        <div class="det-swatch" style="background:${getColor(e.classId)}"></div>
        <span class="det-label">${e.className}</span>
        <span class="det-conf">${(e.confidence * 100).toFixed(0)}%</span>
        ${costHtml}${vendorHtml}
        <span class="det-time">${e.timestamp}</span>
        <button class="log-est" data-id="${e.id}" title="${isRepair ? 'Estimate cost' : 'Find parts'}">$</button>
        <button class="log-del" data-id="${e.id}">✕</button>
      </div>
    `;
  }).join('');
}

// ══════════════════════════════════════════════════
//  Click handlers
// ══════════════════════════════════════════════════
document.addEventListener('click', async (e) => {
  // Live detection → add to log
  const liveItem = e.target.closest('.live-det-item');
  if (liveItem) {
    const idx = +liveItem.dataset.idx;
    const d = currentDets[idx];
    if (!d) return;
    damageLog.push({
      id: logNextId++,
      className: d.className,
      classId: d.classId,
      confidence: d.confidence,
      timestamp: new Date().toLocaleTimeString(),
      bbox: d.bbox,
      estimate: null,
      vendors: null,
      vendorFallback: null,
    });
    renderLog();
    toast(`Logged: ${d.className} ${(d.confidence * 100).toFixed(0)}%`);
    return;
  }

  // $ button on log entry → estimate cost or search vendors
  if (e.target.classList.contains('log-est')) {
    const id = +e.target.dataset.id;
    const entry = damageLog.find(e => e.id === id);
    if (!entry) return;
    await estimateSingle(entry);
    return;
  }

  // Delete log entry
  if (e.target.classList.contains('log-del')) {
    const id = +e.target.dataset.id;
    damageLog = damageLog.filter(e => e.id !== id);
    renderLog();
    return;
  }

  // Click on log entry row → show details
  const logRow = e.target.closest('.log-entry');
  if (logRow && !e.target.classList.contains('log-del') && !e.target.classList.contains('log-est')) {
    const id = +logRow.dataset.logId;
    const entry = damageLog.find(e => e.id === id);
    if (entry && (entry.estimate || entry.vendors)) {
      showEstimateDetail(entry);
    }
  }
});

// Clear all
$('btnClearLog').addEventListener('click', () => {
  damageLog = [];
  logNextId = 1;
  renderLog();
  $('estimatePanel').style.display = 'none';
});

// Close estimate panel
$('btnCloseEstimate').addEventListener('click', () => {
  $('estimatePanel').style.display = 'none';
});

// ══════════════════════════════════════════════════
//  Cost estimation / Vendor search
// ══════════════════════════════════════════════════

// Estimate a single entry
async function estimateSingle(entry) {
  const type = entry.className;

  if (REPAIR_TYPES.has(type)) {
    toast('Estimating repair cost…');
    // Build input for cost-estimator (uses bbox dimensions as proxy for size)
    const [x, y, w, h] = entry.bbox;
    // Convert bbox pixels to approximate meters (rough: assume 1m ≈ 500px at typical distance)
    const PX_TO_M = 1 / 500;
    const input = [{
      damageType: type,
      widthM: w * PX_TO_M,
      heightM: h * PX_TO_M,
      isEstimate: true,
    }];
    const results = await estimateRepairCosts(input);
    if (results.length > 0) {
      entry.estimate = results[0];
      renderLog();
      showEstimateDetail(entry);
      toast(`${type}: $${results[0].estimatedCost} (${results[0].severity})`);
    }
  } else if (PARTS_TYPES.has(type)) {
    toast('Searching for replacement parts…');
    const result = await searchVendors(type);
    entry.vendors = result.vendors;
    entry.vendorFallback = result.fallbackEstimate;
    renderLog();
    showEstimateDetail(entry);
    if (result.vendors.length) {
      toast(`Found ${result.vendors.length} vendors for ${type}`);
    } else {
      toast(`No vendors found — showing estimates`);
    }
  }
}

// Estimate All button
$('btnEstimateAll').addEventListener('click', async () => {
  if (!damageLog.length) { toast('No damage logged yet', true); return; }
  toast('Estimating all…');

  for (const entry of damageLog) {
    if (!entry.estimate && !entry.vendors) {
      await estimateSingle(entry);
    }
  }

  showSummary();
});

// ══════════════════════════════════════════════════
//  Estimate detail panel
// ══════════════════════════════════════════════════
function showEstimateDetail(entry) {
  const panel = $('estimatePanel');
  const body = $('estimateBody');
  panel.style.display = '';

  if (entry.estimate) {
    const e = entry.estimate;
    body.innerHTML = `
      <div class="est-header">
        <div class="est-swatch" style="background:${getColor(entry.classId)}"></div>
        <span class="est-type">${entry.className}</span>
        <span class="est-severity est-severity-${e.severity.toLowerCase()}">${e.severity}</span>
      </div>
      <div class="est-price">$${e.estimatedCost}</div>
      <div class="est-range">$${e.costLow} – $${e.costHigh} ${e.currency}</div>
      <div class="est-breakdown">
        <div class="est-row"><span>Labor</span><span>$${e.breakdown.laborCost}</span></div>
        <div class="est-row"><span>Paint (expected)</span><span>$${e.breakdown.paintCost}</span></div>
        <div class="est-row"><span>Area</span><span>${e.breakdown.areaCm2} cm²</span></div>
        <div class="est-row"><span>Perimeter</span><span>${e.breakdown.perimeterCm} cm</span></div>
        <div class="est-row"><span>Severity ×</span><span>${e.breakdown.severityMultiplier}</span></div>
      </div>
    `;
  } else if (entry.vendors && entry.vendors.length) {
    body.innerHTML = `
      <div class="est-header">
        <div class="est-swatch" style="background:${getColor(entry.classId)}"></div>
        <span class="est-type">${entry.className}</span>
        <span class="est-severity est-severity-parts">Parts</span>
      </div>
      <div class="vendor-list">
        ${entry.vendors.map((v, i) => `
          <div class="vendor-item ${i === 0 ? 'vendor-best' : ''}">
            <div class="vendor-rank">${i + 1}</div>
            <div class="vendor-info">
              <div class="vendor-name">${v.name}</div>
              <div class="vendor-part">${v.partName}</div>
              <div class="vendor-meta">
                ${'★'.repeat(Math.round(v.rating))} ${v.rating} · ${v.inStock ? 'In stock' : 'Out of stock'} · ${v.deliveryDays}d delivery
              </div>
            </div>
            <div class="vendor-price">$${v.price.toFixed(2)}</div>
          </div>
        `).join('')}
      </div>
    `;
  } else if (entry.vendorFallback) {
    const f = entry.vendorFallback;
    body.innerHTML = `
      <div class="est-header">
        <div class="est-swatch" style="background:${getColor(entry.classId)}"></div>
        <span class="est-type">${entry.className}</span>
        <span class="est-severity est-severity-parts">Parts</span>
      </div>
      <div class="est-price">$${f.min} – $${f.max}</div>
      <div class="est-range">${f.partName} · Market average</div>
      <div class="est-note">${f.note}</div>
    `;
  }
}

// Summary of all estimates
function showSummary() {
  const panel = $('estimatePanel');
  const body = $('estimateBody');
  panel.style.display = '';

  let totalLow = 0, totalHigh = 0, totalEst = 0;
  const repairEntries = damageLog.filter(e => e.estimate);
  const partEntries = damageLog.filter(e => e.vendors || e.vendorFallback);

  for (const e of repairEntries) {
    totalLow += e.estimate.costLow;
    totalHigh += e.estimate.costHigh;
    totalEst += e.estimate.estimatedCost;
  }

  for (const e of partEntries) {
    if (e.vendors?.length) {
      const cheapest = e.vendors[0].price;
      totalLow += cheapest;
      totalHigh += cheapest * 1.5;
      totalEst += cheapest;
    } else if (e.vendorFallback) {
      totalLow += e.vendorFallback.min;
      totalHigh += e.vendorFallback.max;
      totalEst += Math.round((e.vendorFallback.min + e.vendorFallback.max) / 2);
    }
  }

  body.innerHTML = `
    <div class="est-header">
      <span class="est-type">Total Estimate</span>
      <span class="est-severity est-severity-summary">${damageLog.length} items</span>
    </div>
    <div class="est-price">$${totalEst}</div>
    <div class="est-range">$${totalLow} – $${totalHigh} USD</div>
    <div class="est-breakdown">
      <div class="est-row"><span>Repairs (${repairEntries.length})</span><span>$${repairEntries.reduce((s, e) => s + e.estimate.estimatedCost, 0)}</span></div>
      <div class="est-row"><span>Parts (${partEntries.length})</span><span>$${partEntries.reduce((s, e) => {
        if (e.vendors?.length) return s + Math.round(e.vendors[0].price);
        if (e.vendorFallback) return s + Math.round((e.vendorFallback.min + e.vendorFallback.max) / 2);
        return s;
      }, 0)}</span></div>
    </div>
  `;
}

// ══════════════════════════════════════════════════
//  Live detections UI
// ══════════════════════════════════════════════════
function updateUI(dets, ms) {
  $('sDet').textContent = dets.length;
  $('sInf').textContent = ms;
  $('sFrm').textContent = frames;

  const now = performance.now();

  for (const d of dets) {
    const existing = liveDets.find(l => l.classId === d.classId && bboxOverlap(l.bbox, d.bbox));
    if (existing) {
      existing.bbox = d.bbox;
      existing.confidence = Math.max(existing.confidence, d.confidence);
      existing.lastSeen = now;
    } else {
      liveDets.push({ classId: d.classId, className: d.className, confidence: d.confidence, bbox: d.bbox, lastSeen: now });
    }
  }

  liveDets = liveDets.filter(l => now - l.lastSeen < LIVE_TTL);
  currentDets = liveDets.sort((a, b) => b.confidence - a.confidence).slice(0, 25);

  $('detCount').textContent = currentDets.length;
  $('sAvg').textContent = currentDets.length
    ? ((currentDets.reduce((s, d) => s + d.confidence, 0) / currentDets.length) * 100).toFixed(0) + '%'
    : '—';

  const list = $('detList');
  if (!currentDets.length) {
    list.innerHTML = running
      ? '<div class="empty-msg">Scanning…<br/>No damage detected.</div>'
      : '<div class="empty-msg">No detections yet.</div>';
  } else {
    list.innerHTML = currentDets.map((d, i) => {
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
