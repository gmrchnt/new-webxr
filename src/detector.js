import * as ort from 'onnxruntime-web';
import { CLASS_NAMES } from './classes.js';

// ── Point ONNX Runtime to CDN for WASM files ──
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.0/dist/';
ort.env.wasm.numThreads = 1;

const INPUT_SIZE = 640;
let session = null;

/**
 * Load YOLOv8n ONNX model from a URL path.
 */
export async function loadModel(url) {
  session = await ort.InferenceSession.create(url, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  return session;
}

export function isModelLoaded() {
  return session !== null;
}

/**
 * Run YOLOv8 inference on a video element or canvas.
 * Returns array of { classId, className, confidence, bbox:[x,y,w,h] }
 */
export async function detect(source, threshold = 0.4) {
  if (!session) return [];

  // Support both <video> and canvas/OffscreenCanvas
  const vw = source.videoWidth || source.width;
  const vh = source.videoHeight || source.height;

  // ── Letterbox resize ──
  const scale = Math.min(INPUT_SIZE / vw, INPUT_SIZE / vh);
  const nw = Math.round(vw * scale);
  const nh = Math.round(vh * scale);
  const dx = (INPUT_SIZE - nw) / 2;
  const dy = (INPUT_SIZE - nh) / 2;

  const offscreen = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  const offCtx = offscreen.getContext('2d');
  offCtx.fillStyle = '#808080';
  offCtx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  offCtx.drawImage(source, dx, dy, nw, nh);

  const imgData = offCtx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const px = imgData.data;

  // ── Build CHW float32 tensor [1,3,640,640] ──
  const total = INPUT_SIZE * INPUT_SIZE;
  const f32 = new Float32Array(3 * total);
  for (let i = 0; i < total; i++) {
    const j = i * 4;
    f32[i]             = px[j]     / 255;
    f32[total + i]     = px[j + 1] / 255;
    f32[2 * total + i] = px[j + 2] / 255;
  }

  const tensor = new ort.Tensor('float32', f32, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const feeds = { [session.inputNames[0]]: tensor };

  // ── Inference ──
  const results = await session.run(feeds);
  const output = results[session.outputNames[0]];

  // ── Parse: output shape [1, 4+num_classes, num_detections] ──
  const data = output.data;
  const numDets = output.dims[2];   // 8400
  const numOut  = output.dims[1];   // 84

  const raw = [];

  for (let i = 0; i < numDets; i++) {
    let maxScore = 0;
    let maxCls = 0;
    for (let c = 4; c < numOut; c++) {
      const s = data[c * numDets + i];
      if (s > maxScore) { maxScore = s; maxCls = c - 4; }
    }
    if (maxScore < threshold) continue;

    const cx = data[0 * numDets + i];
    const cy = data[1 * numDets + i];
    const bw = data[2 * numDets + i];
    const bh = data[3 * numDets + i];

    let x1 = (cx - bw / 2 - dx) / scale;
    let y1 = (cy - bh / 2 - dy) / scale;
    let x2 = (cx + bw / 2 - dx) / scale;
    let y2 = (cy + bh / 2 - dy) / scale;

    x1 = Math.max(0, x1);
    y1 = Math.max(0, y1);
    x2 = Math.min(vw, x2);
    y2 = Math.min(vh, y2);

    raw.push({
      classId: maxCls,
      className: CLASS_NAMES[maxCls] ?? `class_${maxCls}`,
      confidence: maxScore,
      bbox: [x1, y1, x2 - x1, y2 - y1],
    });
  }

  return nms(raw, 0.5);
}

// ── Greedy NMS ──
function nms(dets, iouThresh) {
  dets.sort((a, b) => b.confidence - a.confidence);
  const keep = [];
  for (const d of dets) {
    if (keep.every(k => iou(d.bbox, k.bbox) <= iouThresh)) {
      keep.push(d);
    }
  }
  return keep;
}

function iou(a, b) {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const ix1 = Math.max(ax, bx);
  const iy1 = Math.max(ay, by);
  const ix2 = Math.min(ax + aw, bx + bw);
  const iy2 = Math.min(ay + ah, by + bh);
  if (ix2 <= ix1 || iy2 <= iy1) return 0;
  const inter = (ix2 - ix1) * (iy2 - iy1);
  return inter / (aw * ah + bw * bh - inter);
}
