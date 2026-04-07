/**
 * WebXR AR module.
 * Provides: session management, surface detection, and
 * smart 2D→3D bbox measurement via edge-midpoint hit-tests.
 */

let xrSession = null;
let xrRefSpace = null;
let xrViewerSpace = null;
let xrCenterHitSrc = null;
let gl = null;

export async function isARSupported() {
  return navigator.xr?.isSessionSupported('immersive-ar') ?? false;
}

export async function startARSession(canvas) {
  if (!navigator.xr) throw new Error('WebXR not supported');
  gl = canvas.getContext('webgl2', { xrCompatible: true })
    || canvas.getContext('webgl', { xrCompatible: true });
  if (!gl) throw new Error('WebGL context failed');

  xrSession = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['hit-test', 'local'],
    optionalFeatures: ['dom-overlay'],
    domOverlay: { root: document.getElementById('ar-overlay') },
  });

  xrRefSpace = await xrSession.requestReferenceSpace('local');
  xrViewerSpace = await xrSession.requestReferenceSpace('viewer');

  xrCenterHitSrc = await xrSession.requestHitTestSource({ space: xrViewerSpace });

  const layer = new XRWebGLLayer(xrSession, gl);
  await xrSession.updateRenderState({ baseLayer: layer });
  return xrSession;
}

export function getSession()  { return xrSession; }
export function getRefSpace() { return xrRefSpace; }

export function onXRFrame() {} // kept for API compat

// ─── Surface detection (center of screen) ───
export function getCenterHitTest(frame, refSpace) {
  if (!xrCenterHitSrc || !frame) return null;
  const r = frame.getHitTestResults(xrCenterHitSrc);
  if (!r.length) return null;
  const pose = r[0].getPose(refSpace);
  return pose ? vec(pose.transform.position) : null;
}

// ─── Point hit-test at normalized screen coords (0-1) ───
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

// ─── Smart bbox measurement ───
/**
 * Given a YOLO bbox [x, y, w, h] in camera pixels and the camera
 * resolution, compute the real-world diagonal size of the detection.
 *
 * Strategy: sample 5 points on the bbox (4 edge midpoints + center).
 * Hit-test each. Use the pair with the greatest 3D distance as the
 * diagonal measurement. This is more robust than just using corners
 * because edge midpoints are far more likely to land on the actual
 * object surface rather than the background.
 */
export async function measureBBox(frame, refSpace, bbox, camW, camH) {
  const [bx, by, bw, bh] = bbox;

  // 5 sample points: top-mid, bottom-mid, left-mid, right-mid, center
  const pts = [
    { nx: (bx + bw / 2) / camW, ny: by / camH },           // top center
    { nx: (bx + bw / 2) / camW, ny: (by + bh) / camH },    // bottom center
    { nx: bx / camW,            ny: (by + bh / 2) / camH }, // left center
    { nx: (bx + bw) / camW,     ny: (by + bh / 2) / camH }, // right center
    { nx: (bx + bw / 2) / camW, ny: (by + bh / 2) / camH }, // center
  ];

  // Hit-test all 5 in parallel
  const world = await Promise.all(
    pts.map(p => hitTestAtPoint(frame, refSpace, p.nx, p.ny))
  );

  // Find the pair with the maximum 3D distance
  const valid = world.filter(Boolean);
  if (valid.length < 2) return null;

  let maxDist = 0;
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const d = dist3D(valid[i], valid[j]);
      if (d > maxDist) maxDist = d;
    }
  }

  return maxDist > 0.001 ? maxDist : null;
}

// ─── Utilities ───
export function dist3D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function formatDistance(m) {
  if (m < 0.01) return `${(m * 1000).toFixed(1)} mm`;
  if (m < 1)    return `${(m * 100).toFixed(1)} cm`;
  return `${m.toFixed(2)} m`;
}

function vec(p) { return { x: p.x, y: p.y, z: p.z }; }

export async function endARSession() {
  if (xrCenterHitSrc) { xrCenterHitSrc.cancel(); xrCenterHitSrc = null; }
  if (xrSession) { await xrSession.end(); xrSession = null; }
  xrRefSpace = null; xrViewerSpace = null;
}
