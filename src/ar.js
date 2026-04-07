/**
 * WebXR AR session manager.
 * Provides hit-testing to convert screen taps / bounding box corners
 * into real-world 3D positions, then computes physical distances.
 */

let xrSession = null;
let xrRefSpace = null;
let xrHitTestSource = null;
let xrViewerSpace = null;
let glBinding = null;
let gl = null;

// Pending hit-test requests: array of { screenX, screenY, resolve, reject }
let pendingHitTests = [];

// Store the latest frame + refSpace for on-demand hit tests
let latestFrame = null;
let latestRefSpace = null;

export function isARSupported() {
  return navigator.xr && navigator.xr.isSessionSupported('immersive-ar');
}

/**
 * Start a WebXR immersive-ar session.
 * Returns the XRSession.
 */
export async function startARSession(canvas) {
  if (!navigator.xr) throw new Error('WebXR not supported');

  const supported = await navigator.xr.isSessionSupported('immersive-ar');
  if (!supported) throw new Error('immersive-ar not supported on this device');

  gl = canvas.getContext('webgl2', { xrCompatible: true });
  if (!gl) gl = canvas.getContext('webgl', { xrCompatible: true });
  if (!gl) throw new Error('WebGL context failed');

  xrSession = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['hit-test', 'local'],
    optionalFeatures: ['dom-overlay'],
    domOverlay: { root: document.getElementById('ar-overlay') },
  });

  xrRefSpace = await xrSession.requestReferenceSpace('local');
  xrViewerSpace = await xrSession.requestReferenceSpace('viewer');

  // Persistent hit-test source from viewer (center of screen)
  xrHitTestSource = await xrSession.requestHitTestSource({
    space: xrViewerSpace,
  });

  const glLayer = new XRWebGLLayer(xrSession, gl);
  await xrSession.updateRenderState({ baseLayer: glLayer });

  return xrSession;
}

export function getSession() {
  return xrSession;
}

export function getRefSpace() {
  return xrRefSpace;
}

export function getGL() {
  return gl;
}

/**
 * Called each XR frame to store references for hit-testing.
 */
export function onXRFrame(frame, refSpace) {
  latestFrame = frame;
  latestRefSpace = refSpace;
}

/**
 * Perform a hit-test at normalized screen coordinates (0-1).
 * Returns a 3D position { x, y, z } in meters or null.
 */
export async function hitTestAtPoint(frame, refSpace, x, y) {
  if (!xrSession || !frame) return null;

  try {
    // Create a transient hit-test source for this specific ray
    const ray = new XRRay(
      { x: 0, y: 0, z: 0, w: 1 },
      { x: (x - 0.5) * 2, y: -(y - 0.5) * 2, z: -1, w: 0 }
    );

    const hitTestSource = await xrSession.requestHitTestSource({
      space: xrViewerSpace,
      offsetRay: ray,
    });

    // We need to wait for the next frame to get results
    return new Promise((resolve) => {
      const checkHit = (timestamp, nextFrame) => {
        const results = nextFrame.getHitTestResults(hitTestSource);
        hitTestSource.cancel();

        if (results.length > 0) {
          const pose = results[0].getPose(refSpace);
          if (pose) {
            resolve({
              x: pose.transform.position.x,
              y: pose.transform.position.y,
              z: pose.transform.position.z,
            });
            return;
          }
        }
        resolve(null);
      };
      xrSession.requestAnimationFrame(checkHit);
    });
  } catch (e) {
    console.warn('Hit-test failed:', e);
    return null;
  }
}

/**
 * Get 3D position using the persistent viewer hit-test source.
 * Returns position at center of view or null.
 */
export function getCenterHitTest(frame, refSpace) {
  if (!xrHitTestSource || !frame) return null;

  const results = frame.getHitTestResults(xrHitTestSource);
  if (results.length > 0) {
    const pose = results[0].getPose(refSpace);
    if (pose) {
      return {
        x: pose.transform.position.x,
        y: pose.transform.position.y,
        z: pose.transform.position.z,
      };
    }
  }
  return null;
}

/**
 * Compute Euclidean distance between two 3D points in meters.
 */
export function distance3D(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Convert a distance in meters to a display string.
 */
export function formatDistance(meters) {
  if (meters < 0.01) return `${(meters * 1000).toFixed(1)} mm`;
  if (meters < 1) return `${(meters * 100).toFixed(1)} cm`;
  return `${meters.toFixed(2)} m`;
}

/**
 * Given bounding box corners in normalized screen coords [0-1],
 * perform hit-tests on the two diagonal corners and return the
 * real-world diagonal distance.
 *
 * bbox: [x, y, w, h] in pixel coords
 * canvasW, canvasH: canvas dimensions
 */
export async function measureBBoxDiagonal(frame, refSpace, bbox, canvasW, canvasH) {
  const [bx, by, bw, bh] = bbox;

  // Normalize to 0-1
  const nx1 = bx / canvasW;
  const ny1 = by / canvasH;
  const nx2 = (bx + bw) / canvasW;
  const ny2 = (by + bh) / canvasH;

  const [p1, p2] = await Promise.all([
    hitTestAtPoint(frame, refSpace, nx1, ny1),
    hitTestAtPoint(frame, refSpace, nx2, ny2),
  ]);

  if (p1 && p2) {
    return distance3D(p1, p2);
  }
  return null;
}

/**
 * End the AR session.
 */
export async function endARSession() {
  if (xrHitTestSource) {
    xrHitTestSource.cancel();
    xrHitTestSource = null;
  }
  if (xrSession) {
    await xrSession.end();
    xrSession = null;
  }
  xrRefSpace = null;
  xrViewerSpace = null;
  latestFrame = null;
  latestRefSpace = null;
}
