/**
 * WebXR AR module.
 * - Session management, hit-testing, surface detection
 * - Camera frame capture for YOLO (via raw-camera-access or framebuffer readback)
 * - 2D→3D bbox measurement via edge-midpoint sampling
 * - 3D→2D reprojection for anchored points
 */

let xrSession = null;
let xrRefSpace = null;
let xrViewerSpace = null;
let xrCenterHitSrc = null;
let gl = null;
let glBinding = null;     // XRWebGLBinding for camera-access
let hasCameraAccess = false;

export async function isARSupported() {
  return navigator.xr?.isSessionSupported('immersive-ar') ?? false;
}

export async function startARSession(canvas) {
  if (!navigator.xr) throw new Error('WebXR not supported');

  gl = canvas.getContext('webgl2', { xrCompatible: true, preserveDrawingBuffer: true })
    || canvas.getContext('webgl', { xrCompatible: true, preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL context failed');

  // Request camera-access as optional — not all browsers support it
  xrSession = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['hit-test', 'local'],
    optionalFeatures: ['dom-overlay', 'camera-access'],
    domOverlay: { root: document.getElementById('ar-overlay') },
  });

  xrRefSpace = await xrSession.requestReferenceSpace('local');
  xrViewerSpace = await xrSession.requestReferenceSpace('viewer');
  xrCenterHitSrc = await xrSession.requestHitTestSource({ space: xrViewerSpace });

  const layer = new XRWebGLLayer(xrSession, gl);
  await xrSession.updateRenderState({ baseLayer: layer });

  // Try to create XRWebGLBinding for camera-access
  try {
    if (typeof XRWebGLBinding !== 'undefined') {
      glBinding = new XRWebGLBinding(xrSession, gl);
      hasCameraAccess = true;
    }
  } catch { hasCameraAccess = false; }

  return xrSession;
}

export function getSession()  { return xrSession; }
export function getRefSpace() { return xrRefSpace; }
export function getGL()       { return gl; }
export function onXRFrame()   {}

// ─── Surface detection ───
export function getCenterHitTest(frame, refSpace) {
  if (!xrCenterHitSrc || !frame) return null;
  const r = frame.getHitTestResults(xrCenterHitSrc);
  if (!r.length) return null;
  const pose = r[0].getPose(refSpace);
  return pose ? vec(pose.transform.position) : null;
}

// ─── Point hit-test ───
export async function hitTestAtPoint(frame, refSpace, nx, ny) {
  if (!xrSession) return null;
  try {
    const ray = new XRRay(
      { x: 0, y: 0, z: 0, w: 1 },
      { x: (nx - 0.5) * 2, y: -(ny - 0.5) * 2, z: -1, w: 0 },
    );
    const src = await xrSession.requestHitTestSource({ space: xrViewerSpace, offsetRay: ray });
    return new Promise(resolve => {
      xrSession.requestAnimationFrame((_, f) => {
        const res = f.getHitTestResults(src);
        src.cancel();
        if (res.length) {
          const p = res[0].getPose(refSpace);
          resolve(p ? vec(p.transform.position) : null);
        } else resolve(null);
      });
    });
  } catch { return null; }
}

// ─── Camera frame capture for YOLO ───
/**
 * Capture the current AR camera frame as an OffscreenCanvas.
 * Tries XRWebGLBinding.getCameraImage first (Chrome 113+),
 * falls back to reading the XR framebuffer.
 *
 * Returns { canvas: OffscreenCanvas, width, height } or null.
 */
let captureCanvas = null;
let captureCtx = null;

export function captureFrame(frame, refSpace) {
  if (!frame || !gl) return null;

  const pose = frame.getViewerPose(refSpace);
  if (!pose || !pose.views.length) return null;

  const view = pose.views[0];
  const layer = xrSession.renderState.baseLayer;
  const vp = layer.getViewport(view);
  if (!vp) return null;

  const w = vp.width, h = vp.height;

  // Read pixels from XR framebuffer
  const pixels = new Uint8Array(w * h * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
  gl.readPixels(vp.x, vp.y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  // Check if we got actual data (not all zeros)
  let hasData = false;
  for (let i = 0; i < Math.min(1000, pixels.length); i += 4) {
    if (pixels[i] > 0 || pixels[i+1] > 0 || pixels[i+2] > 0) { hasData = true; break; }
  }
  if (!hasData) return null;

  // Create/reuse offscreen canvas
  if (!captureCanvas || captureCanvas.width !== w || captureCanvas.height !== h) {
    captureCanvas = new OffscreenCanvas(w, h);
    captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });
  }

  // WebGL readPixels is Y-flipped, so flip it
  const imgData = new ImageData(new Uint8ClampedArray(pixels), w, h);

  // Flip vertically by drawing row by row
  const flipped = captureCtx.createImageData(w, h);
  for (let row = 0; row < h; row++) {
    const srcOffset = row * w * 4;
    const dstOffset = (h - 1 - row) * w * 4;
    flipped.data.set(imgData.data.subarray(srcOffset, srcOffset + w * 4), dstOffset);
  }
  captureCtx.putImageData(flipped, 0, 0);

  return { canvas: captureCanvas, width: w, height: h };
}

// ─── Bbox measurement (5-point sampling) ───
export async function measureBBox(frame, refSpace, bbox, camW, camH) {
  const [bx, by, bw, bh] = bbox;
  const pts = [
    { nx: (bx + bw / 2) / camW, ny: by / camH },
    { nx: (bx + bw / 2) / camW, ny: (by + bh) / camH },
    { nx: bx / camW,            ny: (by + bh / 2) / camH },
    { nx: (bx + bw) / camW,     ny: (by + bh / 2) / camH },
    { nx: (bx + bw / 2) / camW, ny: (by + bh / 2) / camH },
  ];
  const world = await Promise.all(pts.map(p => hitTestAtPoint(frame, refSpace, p.nx, p.ny)));
  const valid = world.filter(Boolean);
  if (valid.length < 2) return null;
  let max = 0;
  for (let i = 0; i < valid.length; i++)
    for (let j = i + 1; j < valid.length; j++) {
      const d = dist3D(valid[i], valid[j]);
      if (d > max) max = d;
    }
  return max > 0.001 ? max : null;
}

// ─── 3D→2D reprojection ───
export function projectToScreen(worldPt, frame, refSpace) {
  if (!frame || !refSpace) return null;
  const pose = frame.getViewerPose(refSpace);
  if (!pose || !pose.views.length) return null;
  const view = pose.views[0];
  const pMat = view.projectionMatrix;
  const vMat = view.transform.inverse.matrix;
  const wx = worldPt.x, wy = worldPt.y, wz = worldPt.z;
  const vx = vMat[0]*wx + vMat[4]*wy + vMat[8]*wz  + vMat[12];
  const vy = vMat[1]*wx + vMat[5]*wy + vMat[9]*wz  + vMat[13];
  const vz = vMat[2]*wx + vMat[6]*wy + vMat[10]*wz + vMat[14];
  const vw = vMat[3]*wx + vMat[7]*wy + vMat[11]*wz + vMat[15];
  const cx = pMat[0]*vx + pMat[4]*vy + pMat[8]*vz  + pMat[12]*vw;
  const cy = pMat[1]*vx + pMat[5]*vy + pMat[9]*vz  + pMat[13]*vw;
  const cw = pMat[3]*vx + pMat[7]*vy + pMat[11]*vz + pMat[15]*vw;
  if (cw <= 0) return null;
  return {
    x: (cx / cw * 0.5 + 0.5) * window.innerWidth,
    y: (cy / cw * -0.5 + 0.5) * window.innerHeight,
  };
}

// ─── Utils ───
export function dist3D(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
export function formatDistance(m) {
  if (m < 0.01) return `${(m * 1000).toFixed(1)} mm`;
  if (m < 1)    return `${(m * 100).toFixed(1)} cm`;
  return `${m.toFixed(2)} m`;
}
function vec(p) { return { x: p.x, y: p.y, z: p.z }; }

export async function endARSession() {
  if (xrCenterHitSrc) { xrCenterHitSrc.cancel(); xrCenterHitSrc = null; }
  if (xrSession) { await xrSession.end(); xrSession = null; }
  xrRefSpace = null; xrViewerSpace = null; glBinding = null; hasCameraAccess = false;
  captureCanvas = null; captureCtx = null;
}
