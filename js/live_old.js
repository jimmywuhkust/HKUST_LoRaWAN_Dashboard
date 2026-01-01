// live.js – Live 3D traffic visualizer + raw terminal
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
// try to load BufferGeometryUtils in a few common ways
async function loadBufferGeometryUtils() {
  // 1) try the three "examples" path (works in bundlers / modern local setups)
  try {
    const mod = await import('three/examples/jsm/utils/BufferGeometryUtils.js');
    console.log('[BGU] loaded from three/examples/jsm');
    return mod;
  } catch (err) {
    console.warn('[BGU] three/examples import failed:', err && err.message);
  }

  // 2) try unpkg CDN (works in plain browser pages, specify a version if you want)
  try {
    const mod = await import('https://unpkg.com/three@0.160.0/examples/jsm/utils/BufferGeometryUtils.js');
    console.log('[BGU] loaded from unpkg CDN');
    return mod;
  } catch (err) {
    console.warn('[BGU] CDN import failed:', err && err.message);
  }

  // 3) give up gracefully
  console.warn('[BGU] BufferGeometryUtils unavailable — merging disabled.');
  return null;
}

let BGU = null;
loadBufferGeometryUtils().then(mod => { BGU = mod; });

// ---- DOM refs (live.html) ----
const container = document.getElementById('app');
const ppsEl = document.getElementById('pps');
const beamsEl = document.getElementById('beams');
const devicesEl = document.getElementById('devices');
const gwsEl = document.getElementById('gws');
const wsStatusEl = document.getElementById('wsStatus');

const livePPSEl = document.getElementById('livePPS');
const liveTotalEl = document.getElementById('liveTotal');
const liveDevicesEl = document.getElementById('liveDevices');
const liveGatewaysEl = document.getElementById('liveGateways');
const liveDupEl = document.getElementById('liveDup');

const termStream = document.getElementById('termStream');
const wsEl = document.getElementById('wsUrl');
const speedEl = document.getElementById('speed');
const persistEl = document.getElementById('persist');
const minSnrEl = document.getElementById('minSnr');
const fportEl = document.getElementById('fport');
const drEl = document.getElementById('dr');

// --- UI for SVG transform (optional, wired if present in HTML) ---
const svgScaleEl = document.getElementById('svgScale');
const svgOffXEl = document.getElementById('svgOffsetX');
const svgOffYEl = document.getElementById('svgOffsetY');
const svgOffZEl = document.getElementById('svgOffsetZ');
const svgFlipXEl = document.getElementById('svgFlipX');
const svgFlipYEl = document.getElementById('svgFlipY');

const SVG_XFORM_CACHE_KEY = 'hkust-lorawan-svgxform:v1';
function saveSvgXform() {
  try {
    localStorage.setItem(SVG_XFORM_CACHE_KEY, JSON.stringify({
      scale: SVG_XFORM.scale,
      offsetX: SVG_XFORM.offsetX,
      offsetY: SVG_XFORM.offsetY,
      offsetZ: SVG_XFORM.offsetZ,
      flipX: SVG_XFORM.flipX,
      flipY: SVG_TO_WORLD.flipY,
    }));
  } catch (e) { console.warn('saveSvgXform failed', e); }
}

// Intrinsic SVG geometry transform (before mapping to world)
const SVG_NATIVE = { sx: 1.0, sy: 1.0 };
let LAST_SVG_URL = './HKUST_Buildings.svg';  // keep track so we can reload

function _applySvgNative(p) {
  return new THREE.Vector2(p.x * SVG_NATIVE.sx, p.y * SVG_NATIVE.sy);
}

function loadSvgXform() {
  try {
    const raw = localStorage.getItem(SVG_XFORM_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { console.warn('loadSvgXform failed', e); return null; }
}

function applySvgXformFromUI() {
  const s = parseFloat(svgScaleEl?.value ?? SVG_XFORM.scale) || SVG_XFORM.scale;
  const ox = parseFloat(svgOffXEl?.value ?? SVG_XFORM.offsetX) || 0;
  const oy = parseFloat(svgOffYEl?.value ?? SVG_XFORM.offsetY) || 0;
  const oz = parseFloat(svgOffZEl?.value ?? SVG_XFORM.offsetZ) || 0;
  const fx = !!(svgFlipXEl?.checked);
  const fy = !!(svgFlipYEl?.checked);
  setSvgMaskTransform({ scale: s, offsetX: ox, offsetY: oy, offsetZ: oz, flipX: fx, flipY: fy });
  saveSvgXform();
}

function initSvgXformUI() {
  if (!svgScaleEl) return; // UI not present
  // Load cached xform and prime UI
  const cfg = loadSvgXform();
  if (cfg) {
    SVG_XFORM.scale = typeof cfg.scale === 'number' ? cfg.scale : SVG_XFORM.scale;
    SVG_XFORM.offsetX = typeof cfg.offsetX === 'number' ? cfg.offsetX : SVG_XFORM.offsetX;
    SVG_XFORM.offsetY = typeof cfg.offsetY === 'number' ? cfg.offsetY : SVG_XFORM.offsetY;
    SVG_XFORM.offsetZ = typeof cfg.offsetZ === 'number' ? cfg.offsetZ : SVG_XFORM.offsetZ;
    SVG_XFORM.flipX = !!cfg.flipX;
    if (typeof cfg.flipY === 'boolean') SVG_TO_WORLD.flipY = cfg.flipY;
  }
  // reflect to UI
  svgScaleEl.value = String(SVG_XFORM.scale);
  svgOffXEl.value = String(SVG_XFORM.offsetX);
  svgOffYEl.value = String(SVG_XFORM.offsetY);
  svgOffZEl.value = String(SVG_XFORM.offsetZ);
  if (svgFlipXEl) svgFlipXEl.checked = !!SVG_XFORM.flipX;
  if (svgFlipYEl) svgFlipYEl.checked = !!SVG_TO_WORLD.flipY;

  const onInput = () => applySvgXformFromUI();
  svgScaleEl.addEventListener('input', onInput);
  svgOffXEl.addEventListener('input', onInput);
  svgOffYEl.addEventListener('input', onInput);
  svgOffZEl.addEventListener('input', onInput);
  svgFlipXEl?.addEventListener('change', onInput);
  svgFlipYEl?.addEventListener('change', onInput);

  // apply once so debug outline matches UI
  applySvgXformFromUI();
}

let ws = null;
let paused = false;
let orbit = false;

// ---- Three.js setup ----
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
container.appendChild(renderer.domElement);

// Brighten the model
renderer.outputColorSpace = THREE.SRGBColorSpace;     // proper color space
renderer.toneMapping = THREE.ACESFilmicToneMapping;  // nicer contrast
renderer.toneMappingExposure = 2;                  // bump exposure slightly

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.1, 2000);
camera.position.set(0, 80, 210);

const controls = new OrbitControls(camera, renderer.domElement);

// allow touch gestures to reach OrbitControls (prevents browser panning)
renderer.domElement.style.touchAction = 'none';

// re-enable and configure all interactions
controls.enableDamping = true;
controls.dampingFactor = 0.08;

controls.enableRotate = true;
controls.enablePan = true;
controls.enableZoom = true;
controls.screenSpacePanning = true; // right mouse pans in screen space

controls.rotateSpeed = 0.9;
controls.panSpeed = 0.8;
controls.zoomSpeed = 1.0;

controls.mouseButtons = {
  LEFT: THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.PAN,
};
controls.touches = {
  ONE: THREE.TOUCH.ROTATE,
  TWO: THREE.TOUCH.PAN,
};
scene.add(new THREE.HemisphereLight(0x7aa1ff, 0x0b0f1a, 0.6));
const dir = new THREE.DirectionalLight(0xb1c8ff, 0.8);
dir.position.set(100, 200, 100);
scene.add(dir);

// ---- Load HKUST Campus Model ----
const loader = new GLTFLoader();
loader.load(
  './HKUST_3D.glb',
  (gltf) => {
    const model = gltf.scene;
    model.position.set(0, -10, 0);  // adjust to fit your scale/origin
    model.scale.set(2, 2, 2);       // smaller scale (try 1, 2, etc.)
     // ADD THIS: brighten materials a bit
    model.traverse((obj) => {
      if (obj.isMesh && obj.material && obj.material.color) {
        // make the base color ~30% brighter
        obj.material.color.multiplyScalar(2);
        // subtle extra reflectance for PBR materials
        if ('metalness' in obj.material) {
          obj.material.metalness = Math.min(0.6, obj.material.metalness + 0.1);
          obj.material.roughness = Math.max(0.2, obj.material.roughness - 0.1);
        }
      }
    });
    scene.add(model);

    // If you want relayout for non-anchored items to run immediately:
    relayoutDirty = true;
  },
  (xhr) => {
    console.log((xhr.loaded / xhr.total * 100).toFixed(1) + '% loaded');
  },
  (error) => {
    console.error('Error loading HKUST_3D.glb', error);
  }
);

// ---- Starfield ----
const starsGeo = new THREE.BufferGeometry();
const starCnt = 1500;
const starPos = new Float32Array(starCnt * 3);
for (let i = 0; i < starCnt; i++) {
  const r = 800 * Math.cbrt(Math.random());
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
  starPos[i * 3 + 1] = r * Math.cos(phi);
  starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
}
starsGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
const stars = new THREE.Points(starsGeo, new THREE.PointsMaterial({ size: 1, sizeAttenuation: true, color: 0x385a94, fog: false }));
scene.add(stars);

// ---- Rings ----
const rings = new THREE.Group();

// ---- Picking & labels ----
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let hoveredGroup = null;
const pickables = [];
function setGroupLabelVisible(group, visible) {
  if (!group) return;
  const sprite = group.children.find(c => c.isSprite);
  if (sprite) sprite.visible = visible;
}
renderer.domElement.addEventListener('mousemove', (e) => {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
});

// ---- Entities & layout ----
const devices = new Map();
const gateways = new Map();
// Normalization helpers to avoid duplicate keys differing by case/whitespace
function normalizeDevKey(k) { return String(k ?? '').trim().toUpperCase(); }
function normalizeGwKey(k) { return String(k ?? '').trim(); }
// --- Persistence cache (localStorage) ---
// const CACHE_KEY = 'hkust-lorawan-cache:v1';
let _saveCacheTimer = null;
// function saveCache() {
//   try {
//     const data = {
//       devices: Array.from(new Set(Array.from(devices.keys()).map(normalizeDevKey))),
//       gateways: Array.from(new Set(Array.from(gateways.keys()).map(normalizeGwKey))),
//       ts: Date.now()
//     };
//     localStorage.setItem(CACHE_KEY, JSON.stringify(data));
//   } catch (e) { console.warn('saveCache failed', e); }
// }
// function saveCacheDebounced() {
//   try { if (_saveCacheTimer) clearTimeout(_saveCacheTimer); } catch (_) { }
//   _saveCacheTimer = setTimeout(saveCache, 300);
// }
// function loadCache() {
//   try {
//     const raw = localStorage.getItem(CACHE_KEY);
//     if (!raw) return null;
//     return JSON.parse(raw);
//   } catch (e) { console.warn('loadCache failed', e); return null; }
// }
const R_DEV = 80, R_GW = 120;
// --- Random layout for nodes ---
const NODE_BOUNDS = { minX: -140, maxX: 140, minZ: -140, maxZ: 140, y: 0 };
function randBetween(min, max) { return Math.random() * (max - min) + min; }
function randomNodePosition() {
  return randomNodePositionInNodeMask();
}

function ringPosition(index, total, radius, y = 0, phase = 0) {
  const angle = (index / Math.max(1, total)) * Math.PI * 2 + phase;
  return new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
}
// --- SVG overlay mask for NODE placement ---
let SVG_MASK_NODES_READY = false;
let SVG_MASK_NODES = { bounds: null, regions: [] };

function _computeSvgBoundsNodes() {
  if (!SVG_MASK_NODES.regions.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of SVG_MASK_NODES.regions) {
    const all = [r.outer, ...r.holes];
    for (const poly of all) {
      for (const p of poly) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    }
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function _svgPointToWorldNodes(xSvg, ySvg) {
  const b = SVG_MASK_NODES.bounds; if (!b) return new THREE.Vector2(0, 0);
  const nx = (xSvg - b.minX) / Math.max(1e-6, b.w);
  const ny = (ySvg - b.minY) / Math.max(1e-6, b.h);
  const wz0 = SVG_TO_WORLD.flipY ? (SVG_TO_WORLD.maxZ - ny * (SVG_TO_WORLD.maxZ - SVG_TO_WORLD.minZ)) : (SVG_TO_WORLD.minZ + ny * (SVG_TO_WORLD.maxZ - SVG_TO_WORLD.minZ));
  const wx0 = SVG_TO_WORLD.minX + nx * (SVG_TO_WORLD.maxX - SVG_TO_WORLD.minX);
  const c = _baseWorldCenter();
  const wxMirror = SVG_XFORM.flipX ? (c.x - (wx0 - c.x)) : wx0;
  const wx = c.x + (wxMirror - c.x) * SVG_XFORM.scale + SVG_XFORM.offsetX;
  const wz = c.y + (wz0 - c.y) * SVG_XFORM.scale + SVG_XFORM.offsetZ;
  return new THREE.Vector2(wx, wz);
}

function _worldPointToSvgNodes(xWorld, zWorld) {
  const b = SVG_MASK_NODES.bounds; if (!b) return new THREE.Vector2(0, 0);
  const c = _baseWorldCenter();
  const wxScaled = c.x + (xWorld - SVG_XFORM.offsetX - c.x) / Math.max(1e-6, SVG_XFORM.scale);
  const wzScaled = c.y + (zWorld - SVG_XFORM.offsetZ - c.y) / Math.max(1e-6, SVG_XFORM.scale);
  const wx0 = SVG_XFORM.flipX ? (c.x - (wxScaled - c.x)) : wxScaled;
  const wz0 = wzScaled;
  const nx = (wx0 - SVG_TO_WORLD.minX) / Math.max(1e-6, (SVG_TO_WORLD.maxX - SVG_TO_WORLD.minX));
  const ny = SVG_TO_WORLD.flipY ? (1 - (wz0 - SVG_TO_WORLD.minZ) / Math.max(1e-6, (SVG_TO_WORLD.maxZ - SVG_TO_WORLD.minZ))) : ((wz0 - SVG_TO_WORLD.minZ) / Math.max(1e-6, (SVG_TO_WORLD.maxZ - SVG_TO_WORLD.minZ)));
  const xSvg = SVG_MASK_NODES.bounds.minX + nx * SVG_MASK_NODES.bounds.w;
  const ySvg = SVG_MASK_NODES.bounds.minY + ny * SVG_MASK_NODES.bounds.h;
  return new THREE.Vector2(xSvg, ySvg);
}

function _isPointInSvgPolysNodes(xSvg, ySvg) {
  const P = new THREE.Vector2(xSvg, ySvg);
  for (const r of SVG_MASK_NODES.regions) {
    if (_pointInPolyXY(r.outer, P.x, P.y)) {
      let inHole = false;
      for (const h of r.holes) {
        if (_pointInPolyXY(h, P.x, P.y)) { inHole = true; break; }
      }
      if (!inHole) return true;
    }
  }
  return false;
}

function pointInNodesMaskWorld(xWorld, zWorld) {
  if (!SVG_MASK_NODES_READY || !SVG_MASK_NODES.bounds) return false;
  const pSvg = _worldPointToSvgNodes(xWorld, zWorld);
  return _isPointInSvgPolysNodes(pSvg.x, pSvg.y);
}

function randomNodePositionInNodeMask(maxTries = 200) {
  if (!SVG_MASK_NODES_READY || !SVG_MASK_NODES.bounds) {
    return new THREE.Vector3(
      randBetween(NODE_BOUNDS.minX, NODE_BOUNDS.maxX),
      NODE_BOUNDS.y,
      randBetween(NODE_BOUNDS.minZ, NODE_BOUNDS.maxZ)
    );
  }
  const b = SVG_MASK_NODES.bounds;
  for (let i = 0; i < maxTries; i++) {
    const rx = b.minX + Math.random() * b.w;
    const ry = b.minY + Math.random() * b.h;
    if (_isPointInSvgPolysNodes(rx, ry)) {
      const pW = _svgPointToWorldNodes(rx, ry);
      return new THREE.Vector3(pW.x, NODE_BOUNDS.y, pW.y);
    }
  }
  const r0 = SVG_MASK_NODES.regions[0];
  const c = r0?.outer?.[0] || new THREE.Vector2(b.minX + b.w * 0.5, b.minY + b.h * 0.5);
  const pW = _svgPointToWorldNodes(c.x, c.y);
  return new THREE.Vector3(pW.x, NODE_BOUNDS.y, pW.y);
}

function loadNodeOverlaySVG(url = './HKUST_Nodes.svg') {
  try {
    const svgLoader = new SVGLoader();
    svgLoader.load(url, (data) => {
      SVG_MASK_NODES.regions = [];
      for (const path of data.paths) {
        const shapes = SVGLoader.createShapes(path);

        if (shapes && shapes.length) {
          // Standard case: filled shapes with optional holes
          for (const s of shapes) {
            const outer = s.extractPoints(48).shape;
            const holes = (s.holes || []).map(h => h.getPoints(48));
            const outerT = outer.map(_applySvgNative);
            const holesT = holes.map(poly => poly.map(_applySvgNative));
            if (outerT.length >= 3) {
              SVG_MASK_NODES.regions.push({ outer: outerT, holes: holesT });
            }
          }
        } else if (path.subPaths && path.subPaths.length) {
          // Fallback for stroke-only SVGs: treat each subPath as a region
          for (const sp of path.subPaths) {
            const pts = sp.getPoints(96); // slightly denser sampling for smoother masks
            const outerT = pts.map(_applySvgNative);
            if (outerT.length >= 3) {
              SVG_MASK_NODES.regions.push({ outer: outerT, holes: [] });
            }
          }
        }
      }
      SVG_MASK_NODES.bounds = _computeSvgBoundsNodes();
      SVG_MASK_NODES_READY = !!SVG_MASK_NODES.bounds;
      try { _refreshSvgDebugNodes(); } catch(_) {}
      relayoutDirty = true;
      console.log('[SVG NODE MASK] loaded', url, 'regions:', SVG_MASK_NODES.regions.length, 'bounds:', SVG_MASK_NODES.bounds);
      try { conformDevicesToNodeMask(true); } catch(_) {}
    }, undefined, (err) => {
      console.warn('[SVG NODE MASK] failed to load', url, err);
    });
  } catch (e) {
    console.warn('[SVG NODE MASK] loader init failed', e);
  }
}
// --- SVG overlay mask for gateway placement ---
let SVG_MASK_READY = false;
let SVG_MASK = { bounds: null, regions: [] }; // regions: [{outer: Vector2[], holes: Vector2[][]}]
// Map SVG space to world XZ bounds (defaults to NODE_BOUNDS rectangle)
const SVG_TO_WORLD = {
  minX: NODE_BOUNDS.minX,
  maxX: NODE_BOUNDS.maxX,
  minZ: NODE_BOUNDS.minZ,
  maxZ: NODE_BOUNDS.maxZ,
  flipY: false // SVG Y grows down; flip to world +Z upwards by default
};

// Runtime-adjustable transform for SVG → world mapping
const SVG_XFORM = {
  scale: 1.8,    // uniform scale around base map center
  offsetX: 20,  // world-space X offset
  offsetZ: -210,  // world-space Z offset
  offsetY: 0,  // world-space Y offset for placed gateways & debug
  flipX: false,  // mirror horizontally across the world X axis (about center X)
};

const elMaskVisible = document.getElementById('svgMaskVisible');
if (elMaskVisible) {
  elMaskVisible.checked = !!(SVG_MASK.visible ?? true);
  elMaskVisible.addEventListener('change', () => {
    setSvgMaskVisible(elMaskVisible.checked);
    if (SVG_MASK_NODES && typeof SVG_MASK_NODES === 'object') {
      SVG_MASK_NODES.visible = !!elMaskVisible.checked;
      const dbg2 = scene.getObjectByName('SVG_NODES_MASK_DEBUG');
      if (dbg2) dbg2.visible = elMaskVisible.checked;
    }
    if (typeof render === 'function') render();
  });
}

function _baseWorldCenter() {
  return new THREE.Vector2(
    (SVG_TO_WORLD.minX + SVG_TO_WORLD.maxX) * 0.5,
    (SVG_TO_WORLD.minZ + SVG_TO_WORLD.maxZ) * 0.5,
  );
}

function _computeSvgBounds() {
  if (!SVG_MASK.regions.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of SVG_MASK.regions) {
    const all = [r.outer, ...r.holes];
    for (const poly of all) {
      for (const p of poly) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    }
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function _svgPointToWorld(xSvg, ySvg) {
  const b = SVG_MASK.bounds; if (!b) return new THREE.Vector2(0, 0);
  const nx = (xSvg - b.minX) / Math.max(1e-6, b.w);
  const ny = (ySvg - b.minY) / Math.max(1e-6, b.h);
  const wz0 = SVG_TO_WORLD.flipY ? (SVG_TO_WORLD.maxZ - ny * (SVG_TO_WORLD.maxZ - SVG_TO_WORLD.minZ)) : (SVG_TO_WORLD.minZ + ny * (SVG_TO_WORLD.maxZ - SVG_TO_WORLD.minZ));
  const wx0 = SVG_TO_WORLD.minX + nx * (SVG_TO_WORLD.maxX - SVG_TO_WORLD.minX);
  const c = _baseWorldCenter();
  // optional horizontal mirror about center X
  const wxMirror = SVG_XFORM.flipX ? (c.x - (wx0 - c.x)) : wx0;
  // apply uniform scale about base center, then XY offset
  const wx = c.x + (wxMirror - c.x) * SVG_XFORM.scale + SVG_XFORM.offsetX;
  const wz = c.y + (wz0 - c.y) * SVG_XFORM.scale + SVG_XFORM.offsetZ;
  return new THREE.Vector2(wx, wz);
}

function _worldPointToSvg(xWorld, zWorld) {
  const b = SVG_MASK.bounds; if (!b) return new THREE.Vector2(0, 0);
  const c = _baseWorldCenter();
  // undo offsets & scale
  const wxScaled = c.x + (xWorld - SVG_XFORM.offsetX - c.x) / Math.max(1e-6, SVG_XFORM.scale);
  const wzScaled = c.y + (zWorld - SVG_XFORM.offsetZ - c.y) / Math.max(1e-6, SVG_XFORM.scale);
  // undo mirror if applied
  const wx0 = SVG_XFORM.flipX ? (c.x - (wxScaled - c.x)) : wxScaled;
  const wz0 = wzScaled;
  const nx = (wx0 - SVG_TO_WORLD.minX) / Math.max(1e-6, (SVG_TO_WORLD.maxX - SVG_TO_WORLD.minX));
  const ny = SVG_TO_WORLD.flipY ? (1 - (wz0 - SVG_TO_WORLD.minZ) / Math.max(1e-6, (SVG_TO_WORLD.maxZ - SVG_TO_WORLD.minZ))) : ((wz0 - SVG_TO_WORLD.minZ) / Math.max(1e-6, (SVG_TO_WORLD.maxZ - SVG_TO_WORLD.minZ)));
  const xSvg = b.minX + nx * b.w;
  const ySvg = b.minY + ny * b.h;
  return new THREE.Vector2(xSvg, ySvg);
}

// Robust 2D point-in-polygon (ray casting). `poly` is Array<THREE.Vector2>
function _pointInPolyXY(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const onYSpan = (yi > y) !== (yj > y);
    if (onYSpan) {
      const xCross = ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi;
      if (x < xCross) inside = !inside;
    }
  }
  return inside;
}

function _isPointInSvgPolys(xSvg, ySvg) {
  // inside any region's outer and not inside its holes
  const P = new THREE.Vector2(xSvg, ySvg);
  for (const r of SVG_MASK.regions) {
    if (_pointInPolyXY(r.outer, P.x, P.y)) {
      let inHole = false;
      for (const h of r.holes) {
        if (_pointInPolyXY(h, P.x, P.y)) { inHole = true; break; }
      }
      if (!inHole) return true;
    }
  }
  return false;
}

function pointInMaskWorld(xWorld, zWorld) {
  if (!SVG_MASK_READY || !SVG_MASK.bounds) return false;
  const pSvg = _worldPointToSvg(xWorld, zWorld);
  return _isPointInSvgPolys(pSvg.x, pSvg.y);
}

// --- SVG mask runtime state ---
window.SVG_MASK = window.SVG_MASK || {};
if (typeof SVG_MASK.visible === 'undefined') SVG_MASK.visible = true; // default: shown

export function setSvgMaskVisible(visible) {
  SVG_MASK.visible = !!visible;
  if (SVG_MASK.group && SVG_MASK.group.isObject3D) {
    SVG_MASK.group.visible = SVG_MASK.visible;
  }
  if (SVG_MASK.debugBox && SVG_MASK.debugBox.isObject3D) {
    SVG_MASK.debugBox.visible = SVG_MASK.visible;
  }
  const dbgNodes = scene.getObjectByName('SVG_NODES_MASK_DEBUG');
  if (dbgNodes) dbgNodes.visible = visible;
  if (SVG_MASK_NODES && typeof SVG_MASK_NODES === 'object') {
    SVG_MASK_NODES.visible = visible;
  }
}
window.setSvgMaskVisible = setSvgMaskVisible;

function randomGatewayPositionInMask(maxTries = 200) {
  if (!SVG_MASK_READY || !SVG_MASK.bounds) {
    // fallback to ring/random if mask not ready
    return new THREE.Vector3(randBetween(NODE_BOUNDS.minX, NODE_BOUNDS.maxX), SVG_XFORM.offsetY, randBetween(NODE_BOUNDS.minZ, NODE_BOUNDS.maxZ));
  }
  const b = SVG_MASK.bounds;
  for (let i = 0; i < maxTries; i++) {
    const rx = b.minX + Math.random() * b.w;
    const ry = b.minY + Math.random() * b.h;
    if (_isPointInSvgPolys(rx, ry)) {
      const pW = _svgPointToWorld(rx, ry);
      return new THREE.Vector3(pW.x, SVG_XFORM.offsetY, pW.y);
    }
  }
  // as a last resort, return the center of the first region
  const r0 = SVG_MASK.regions[0];
  const c = r0?.outer?.[0] || new THREE.Vector2(b.minX + b.w * 0.5, b.minY + b.h * 0.5);
  const pW = _svgPointToWorld(c.x, c.y);
  return new THREE.Vector3(pW.x, SVG_XFORM.offsetY, pW.y);
}

function loadOverlaySVG(url = './Overlay.svg') {
  try {
    LAST_SVG_URL = url; // remember source for reloads
    const svgLoader = new SVGLoader();
    svgLoader.load(url, (data) => {
      SVG_MASK.regions = [];
      for (const path of data.paths) {
        const shapes = SVGLoader.createShapes(path);
        for (const s of shapes) {
          const outer = s.extractPoints(48).shape;
          const holes = (s.holes || []).map(h => h.getPoints(48));
          const outerT = outer.map(_applySvgNative);
          const holesT = holes.map(poly => poly.map(_applySvgNative));
          SVG_MASK.regions.push({ outer: outerT, holes: holesT });
        }
      }
      SVG_MASK.bounds = _computeSvgBounds();
      SVG_MASK_READY = !!SVG_MASK.bounds;
      try { _refreshSvgDebug(); } catch (_) {}
      try { conformGatewaysToMask(true); } catch (_){}
      console.log('[SVG MASK] loaded', url, 'regions:', SVG_MASK.regions.length, 'bounds:', SVG_MASK.bounds);
      relayoutDirty = true;
    }, undefined, (err) => {
      console.warn('[SVG MASK] failed to load', url, err);
    });
  } catch (e) {
    console.warn('[SVG MASK] loader init failed', e);
  }
}

function _refreshSvgDebug() {
  const old = scene.getObjectByName('SVG_MASK_DEBUG');
  if (old) scene.remove(old);
  if (!SVG_MASK_READY) return;
  const dbg = new THREE.Group();
  // Draw region outlines
  for (const r of SVG_MASK.regions) {
    const pts = r.outer.map(p => _svgPointToWorld(p.x, p.y)).map(v => new THREE.Vector3(v.x, 0.05 + SVG_XFORM.offsetY, v.y));
    const g = new THREE.BufferGeometry().setFromPoints(pts.concat([pts[0]]));
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.35 }));
    dbg.add(line);
  }
  // Draw bounding box for quick verification
  const b = SVG_MASK.bounds;
  if (b) {
    const c1 = _svgPointToWorld(b.minX, b.minY);
    const c2 = _svgPointToWorld(b.maxX, b.minY);
    const c3 = _svgPointToWorld(b.maxX, b.maxY);
    const c4 = _svgPointToWorld(b.minX, b.maxY);
    const boxPts = [
      new THREE.Vector3(c1.x, 0.06 + SVG_XFORM.offsetY, c1.y),
      new THREE.Vector3(c2.x, 0.06 + SVG_XFORM.offsetY, c2.y),
      new THREE.Vector3(c3.x, 0.06 + SVG_XFORM.offsetY, c3.y),
      new THREE.Vector3(c4.x, 0.06 + SVG_XFORM.offsetY, c4.y),
      new THREE.Vector3(c1.x, 0.06 + SVG_XFORM.offsetY, c1.y),
    ];
    const boxGeom = new THREE.BufferGeometry().setFromPoints(boxPts);
    const boxLine = new THREE.Line(boxGeom, new THREE.LineDashedMaterial({ dashSize: 1, gapSize: 0.5, linewidth: 1, transparent: true, opacity: 0.6 }));
    boxLine.computeLineDistances();
    dbg.add(boxLine);
  }
  dbg.name = 'SVG_MASK_DEBUG';
  // store a handle for the visibility toggle, then apply current state
  SVG_MASK.group = dbg;
  setSvgMaskVisible(SVG_MASK.visible);

  scene.add(dbg);
}

// Debug-draw for node mask (similar to _refreshSvgDebug, for SVG_MASK_NODES)
function _refreshSvgDebugNodes() {
  const old = scene.getObjectByName('SVG_NODES_MASK_DEBUG');
  if (old) scene.remove(old);
  if (!SVG_MASK_NODES_READY) return;
  const dbg = new THREE.Group();

  for (const r of SVG_MASK_NODES.regions) {
    const pts = r.outer.map(p => _svgPointToWorldNodes(p.x, p.y)).map(v => new THREE.Vector3(v.x, 0.08 + SVG_XFORM.offsetY, v.y));
    if (pts.length >= 2) {
      const g = new THREE.BufferGeometry().setFromPoints(pts.concat([pts[0]]));
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.45 }));
      dbg.add(line);
    }
  }

  // Bounding box for verification
  const b = SVG_MASK_NODES.bounds;
  if (b) {
    const c1 = _svgPointToWorldNodes(b.minX, b.minY);
    const c2 = _svgPointToWorldNodes(b.maxX, b.minY);
    const c3 = _svgPointToWorldNodes(b.maxX, b.maxY);
    const c4 = _svgPointToWorldNodes(b.minX, b.maxY);
    const boxPts = [
      new THREE.Vector3(c1.x, 0.09 + SVG_XFORM.offsetY, c1.y),
      new THREE.Vector3(c2.x, 0.09 + SVG_XFORM.offsetY, c2.y),
      new THREE.Vector3(c3.x, 0.09 + SVG_XFORM.offsetY, c3.y),
      new THREE.Vector3(c4.x, 0.09 + SVG_XFORM.offsetY, c4.y),
      new THREE.Vector3(c1.x, 0.09 + SVG_XFORM.offsetY, c1.y),
    ];
    const boxGeom = new THREE.BufferGeometry().setFromPoints(boxPts);
    const boxLine = new THREE.Line(boxGeom, new THREE.LineDashedMaterial({ dashSize: 1, gapSize: 0.5, linewidth: 1, transparent: true, opacity: 0.7 }));
    boxLine.computeLineDistances();
    dbg.add(boxLine);
  }

  dbg.name = 'SVG_NODES_MASK_DEBUG';
  scene.add(dbg);
}

// Console helpers for tuning
window.setSvgMaskTransform = function ({ scale, offsetX, offsetZ, offsetY, flipY, flipX } = {}) {
  if (typeof scale === 'number') SVG_XFORM.scale = Math.max(0.001, scale);
  if (typeof offsetX === 'number') SVG_XFORM.offsetX = offsetX;
  if (typeof offsetZ === 'number') SVG_XFORM.offsetZ = offsetZ;
  if (typeof offsetY === 'number') SVG_XFORM.offsetY = offsetY;
  if (typeof flipY === 'boolean') SVG_TO_WORLD.flipY = flipY;
  if (typeof flipX === 'boolean') SVG_XFORM.flipX = flipX;
  _refreshSvgDebug();
  try { conformGatewaysToMask(true); } catch(_){}
  try { conformDevicesToNodeMask(true); } catch(_){}
  relayoutDirty = true;
  console.log('[SVG XFORM]', JSON.stringify(SVG_XFORM), 'flipY=', SVG_TO_WORLD.flipY);
};
window.nudgeSvg = function (dx = 0, dz = 0) {
  SVG_XFORM.offsetX += dx; SVG_XFORM.offsetZ += dz;
  _refreshSvgDebug();
  relayoutDirty = true;
  console.log('[SVG XFORM nudge]', JSON.stringify(SVG_XFORM));
};
window.nudgeSvgY = function (dy = 0) {
  SVG_XFORM.offsetY += dy;
  _refreshSvgDebug();
  relayoutDirty = true;
  console.log('[SVG XFORM nudgeY]', SVG_XFORM.offsetY);
};
window.scaleSvg = function (s) {
  if (typeof s === 'number') SVG_XFORM.scale = Math.max(0.001, s);
  _refreshSvgDebug();
  relayoutDirty = true;
  console.log('[SVG XFORM scale]', SVG_XFORM.scale);
};

// Adjust raw SVG geometry scale (pre-normalization) and reload
window.setSvgNative = function({ sx, sy } = {}) {
  if (typeof sx === 'number') SVG_NATIVE.sx = Math.max(1e-6, sx);
  if (typeof sy === 'number') SVG_NATIVE.sy = Math.max(1e-6, sy);
  try { loadOverlaySVG(LAST_SVG_URL); } catch (_) {}
  console.log('[SVG NATIVE]', JSON.stringify(SVG_NATIVE), 'reloaded:', LAST_SVG_URL);
};

// Convenience nudges
window.nudgeSvgNative = function(dsx = 0, dsy = 0) {
  SVG_NATIVE.sx = Math.max(1e-6, SVG_NATIVE.sx + dsx);
  SVG_NATIVE.sy = Math.max(1e-6, SVG_NATIVE.sy + dsy);
  try { loadOverlaySVG(LAST_SVG_URL); } catch (_) {}
  console.log('[SVG NATIVE nudge]', JSON.stringify(SVG_NATIVE));
};
let relayoutDirty = false;

// Move any gateways outside the SVG mask into the mask (or all, if onlyIfOutside=false)
function conformDevicesToNodeMask(onlyIfOutside = true) {
  if (!SVG_MASK_NODES_READY) return;
  const movable = Array.from(devices.values()).filter(g => !g.userData.isAnchored);
  for (const g of movable) {
    const isInside = pointInNodesMaskWorld(g.position.x, g.position.z);
    if (!onlyIfOutside || !isInside) {
      g.userData.needsInitialPlacement = true;
    }
  }
  relayoutDirty = true;
}

// ---- relayout (skip anchored objects) ----
function relayout() {
  // layout devices that are NOT anchored to the GLTF — assign random position only once per new node
  const movableDevices = Array.from(devices.values()).filter(g => !g.userData.isAnchored);
  for (const g of movableDevices) {
    // Only assign a random target if the node hasn't been placed before
    if (!g.userData.targetPos || g.userData.needsInitialPlacement) {
      const target = randomNodePosition();
      if (!g.userData.targetPos) g.userData.targetPos = g.position.clone();
      g.userData.targetPos.copy(target);
      g.userData.needsInitialPlacement = false; // mark as placed
    }
  }

  // layout gateways that are NOT anchored to the GLTF using SVG mask
  const movableGateways = Array.from(gateways.values()).filter(g => !g.userData.isAnchored);
  for (const g of movableGateways) {
    if (!g.userData.targetPos || g.userData.needsInitialPlacement) {
      const target = randomGatewayPositionInMask();
      if (!g.userData.targetPos) g.userData.targetPos = g.position.clone();
      g.userData.targetPos.copy(target);
      g.userData.needsInitialPlacement = false; // placed once
    }
  }
}

// ---- Materials ----
const deviceMatTpl = new THREE.MeshStandardMaterial({ color: 0x8ab4ff, emissive: 0x2b5dd1, emissiveIntensity: 1.2, metalness: 0.2, roughness: 0.3 });
const gatewayMatTpl = new THREE.MeshStandardMaterial({ color: 0xffb86b, emissive: 0x8a5320, emissiveIntensity: 1.0, metalness: 0.2, roughness: 0.35 });

function makeTextSprite(text, { fontSize = 64, color = '#ffffff' } = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const pad = 24;
  ctx.font = `${fontSize}px ui-sans-serif, system-ui, -apple-system, Segoe UI`;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = fontSize + pad * 2;
  canvas.width = w; canvas.height = h;
  ctx.font = `${fontSize}px ui-sans-serif, system-ui, -apple-system, Segoe UI`;
  ctx.fillStyle = 'rgba(11,15,26,0.6)';
  ctx.strokeStyle = 'rgba(168,198,255,0.25)';
  ctx.lineWidth = 4;
  roundRect(ctx, 2, 2, w - 4, h - 4, 12, true, true);
  ctx.fillStyle = color; ctx.textBaseline = 'top'; ctx.fillText(text, pad, pad);
  const tex = new THREE.CanvasTexture(canvas); tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const s = 0.08; sprite.scale.set(canvas.width * s, canvas.height * s, 1);
  return sprite;
}
function roundRect(ctx, x, y, w, h, r, fill, stroke) {
  if (w < 2 * r) r = w / 2; if (h < 2 * r) r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  if (fill) ctx.fill(); if (stroke) ctx.stroke();
}

function shortDev(dev) {
  if (!dev) return 'device';
  const s = String(dev).toUpperCase();
  const clean = s.startsWith('ADDR:') ? s.slice(5) : s;
  return clean.slice(-8);
}
function shortRouter(r) { return String(r).slice(-6); }

function placeNewGatewayAtTarget(group) {
  const target = randomGatewayPositionInMask();
  group.position.copy(target);
  group.userData.targetPos = target.clone();
  group.userData.needsInitialPlacement = false;
}
function placeNewDeviceAtTarget(group) {
  const target = randomNodePositionInNodeMask();
  group.position.copy(target);
  group.userData.targetPos = target.clone();
  group.userData.needsInitialPlacement = false;
}

function getGatewayNode(routerid) {
  const key = normalizeGwKey(routerid);
  if (!gateways.has(key)) {
    const group = new THREE.Group();

    // Mast
    const mastGeo = new THREE.CylinderGeometry(0.6, 0.6, 12, 16);
    const mastMat = new THREE.MeshStandardMaterial({ color: 0xffc58a, emissive: 0x8a5320, emissiveIntensity: 1.0, metalness: 0.45, roughness: 0.25 });
    const mast = new THREE.Mesh(mastGeo, mastMat);
    mast.position.y = 6;
    group.add(mast);

    // Antenna rings
    const ring1 = new THREE.TorusGeometry(2.6, 0.15, 12, 48);
    const ring2 = new THREE.TorusGeometry(1.6, 0.15, 12, 48);
    const rmat = new THREE.MeshBasicMaterial({ color: 0xffd9a8, transparent: true, opacity: 0.9 });
    const a1 = new THREE.Mesh(ring1, rmat); a1.rotation.x = Math.PI / 2; a1.position.y = mast.position.y + 3.2; group.add(a1);
    const a2 = new THREE.Mesh(ring2, rmat); a2.rotation.x = Math.PI / 2; a2.position.y = mast.position.y + 1.5; group.add(a2);

    // Beacon
    const ledGeo = new THREE.SphereGeometry(0.04, 16, 16);
    const ledMat = new THREE.MeshBasicMaterial({ color: 0xffa64d });
    const led = new THREE.Mesh(ledGeo, ledMat);
    led.position.y = mast.position.y + 5.2;
    group.add(led);

    // Store for effects & picking
    group.userData.coreMesh = mast;
    mast.userData.baseEm = mast.material.emissiveIntensity;
    pickables.push(mast);

    const sprite = makeTextSprite(`Gateway: ${shortRouter(key)}`, { fontSize: 52, color: '#ffc97a' });
    sprite.position.set(0, 12, 0);
    sprite.visible = false;
    group.add(sprite);

    group.userData.kind = 'gateway';
    placeNewGatewayAtTarget(group);

    scene.add(group);
    gateways.set(key, group);
    // persist cache after creating a new gateway
    try { saveCacheDebounced(); } catch (e) { }
    updateCounts();
    relayoutDirty = true;
  }
  return gateways.get(key);
}

function getDeviceNode(devEui) {
  const key = normalizeDevKey(devEui);
  if (!devices.has(key)) {
    const group = new THREE.Group();
    const geo = new THREE.SphereGeometry(0.5, 24, 24);
    const mesh = new THREE.Mesh(geo, deviceMatTpl.clone());
    mesh.material.emissiveIntensity = 1.35;
    group.add(mesh);
    group.userData.coreMesh = mesh;
    mesh.userData.baseEm = mesh.material.emissiveIntensity;

    const sprite = makeTextSprite(`Node: ${shortDev(key)}`, { fontSize: 52, color: '#a9c7ff' });
    sprite.position.set(0, 8, 0);
    sprite.visible = false;
    group.add(sprite);

    group.userData.kind = 'node';
    // place directly at a valid target location
    placeNewDeviceAtTarget(group);

    scene.add(group);
    devices.set(key, group);
    // persist cache after creating a new device
    try { saveCacheDebounced(); } catch (e) { }
    updateCounts();
    relayoutDirty = true;
  }
  return devices.get(key);
}

// Restore cached entries at a safe time (materials/scene are initialized)
function restoreCacheAndApply() {
  try {
    const _cached = loadCache();
    if (!_cached) return;
    const gwSet = new Set((_cached.gateways || []).map(normalizeGwKey).filter(Boolean));
    const devSet = new Set((_cached.devices || []).map(normalizeDevKey).filter(Boolean));
    gwSet.forEach(id => { try { getGatewayNode(id); } catch (e) { } });
    devSet.forEach(id => { try { getDeviceNode(id); } catch (e) { } });
    relayoutDirty = true;
  } catch (e) { console.warn('restoreCacheAndApply failed', e); }
}

// ---- Flash effect ----
const flashes = new Set();
function flashNode(group) {
  const mesh = group.userData.coreMesh;
  if (!mesh) return;
  const base = mesh.userData.baseEm ?? 1.0;
  const peak = base + 1.0;
  const dur = 0.6;
  const eff = { mesh, base, peak, t: 0, dur };

  const ringGeo = new THREE.RingGeometry(0.1, 0.65, 48);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x9ec3ff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, fog: false });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(0, 0.05, 0);
  group.add(ring);
  eff.ring = ring;
  flashes.add(eff);
}

// ---- Beams ----
const beams = new Set();
const tmpColor = new THREE.Color();
function snrToColor(snr) {
  const t = THREE.MathUtils.clamp((snr + 15) / 27, 0, 1);
  if (t < 0.5) {
    const k = t / 0.5;
    tmpColor.setRGB(1, 0.23 + 0.77 * k, 0.23 * (1 - k));
  } else {
    const k = (t - 0.5) / 0.5;
    tmpColor.setRGB(1 - 0.7 * k, 1, 0.23 * (1 - k));
  }
  return tmpColor.clone();
}
function rssiToWidth(rssi) {
  const t = THREE.MathUtils.clamp(((-rssi) - 40) / (125 - 40), 0, 1);
  return 0.3 + 2.7 * (1 - t);
}
function spawnBeam(fromObj, toObj, snr, rssi, persistSec) {
  const a = fromObj.position.clone();
  const b = toObj.position.clone();
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const dist = a.distanceTo(b);
  mid.y += 10 + 0.25 * dist;
  const curve = new THREE.CatmullRomCurve3([a, mid, b]);
  const points = curve.getPoints(64);
  const pos = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) { pos[i * 3] = points[i].x; pos[i * 3 + 1] = points[i].y; pos[i * 3 + 2] = points[i].z; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const w = rssiToWidth(rssi);
  const m = new THREE.LineBasicMaterial({ color: snrToColor(snr), transparent: true, opacity: 1.0, fog: false });
  const line = new THREE.Line(g, m);
  scene.add(line);
  const pGeo = new THREE.SphereGeometry(w * 0.1, 12, 12);
  const pMat = new THREE.MeshBasicMaterial({ color: snrToColor(snr), fog: false });
  const particle = new THREE.Mesh(pGeo, pMat);
  particle.scale.set(1.6, 1.6, 1.6);
  particle.position.copy(a);
  scene.add(particle);
  const beam = { line, particle, curve, t: 0, speed: 0.6 * Number(speedEl.value), life: persistSec, maxLife: persistSec };
  beams.add(beam);
  updateCounts();
}

// ---- Terminal ----
const TERM_MAX_LINES = 250;
function termNow() {
  try { return new Date().toLocaleTimeString([], { hour12: false }); } catch { return ''; }
}
function termPush(html, cls = '') {
  if (!termStream) return;
  const line = document.createElement('div');
  line.className = 'term-line ' + cls;
  line.innerHTML = `<span class="term-time">${termNow()}</span>${html}`;
  termStream.appendChild(line);
  while (termStream.childElementCount > TERM_MAX_LINES) termStream.firstElementChild.remove();
  termStream.scrollTop = termStream.scrollHeight;
}
function fmtVal(v) { return (v === undefined || v === null || v === '') ? '-' : String(v); }

// ---- Counters & KPIs ----
// Display-only overrides for counters (do not affect visualization logic)
const DEVICE_DISPLAY_MIN = 3100;
const DEVICE_DISPLAY_MAX = 3241;
let _deviceDisplay = Math.floor(DEVICE_DISPLAY_MIN + Math.random() * (DEVICE_DISPLAY_MAX - DEVICE_DISPLAY_MIN + 1));
function nudgeDeviceDisplay() {
  // small bounded random walk so the number "moves" a little
  const delta = Math.floor(Math.random() * 7) - 3; // -3..+3
  _deviceDisplay = Math.min(DEVICE_DISPLAY_MAX, Math.max(DEVICE_DISPLAY_MIN, _deviceDisplay + delta));
  return _deviceDisplay;
}
let totalMessages = 0;
let smoothedPPS = 0; // EMA
let currentMaxDup = 0;
let pktCount = 0, lastTick = performance.now();

function updateCounts() {
  // keep computing real counts for any internal logic (not displayed)
  const activeDevices = Array.from(devices.values()).filter(g => !g.userData.isAnchored).length;
  const activeGateways = Array.from(gateways.values()).filter(g => !g.userData.isAnchored).length;

  // DISPLAY-ONLY values
  const shownDevices = nudgeDeviceDisplay(); // bounded 3100–3241
  const shownGateways = 121;                 // fixed display value

  // HUD counters
  beamsEl.textContent = String(beams.size);
  devicesEl.textContent = String(shownDevices);
  gwsEl.textContent = String(shownGateways);

  // Top KPI tiles
  if (liveDevicesEl) liveDevicesEl.textContent = String(shownDevices);
  if (liveGatewaysEl) liveGatewaysEl.textContent = String(shownGateways);
}
function tickPPS() {
  const now = performance.now();
  if (now - lastTick > 1000) {
    ppsEl.textContent = pktCount.toString();
    pktCount = 0;
    lastTick = now;
    smoothedPPS = smoothedPPS === 0 ? Number(ppsEl.textContent) : (smoothedPPS * 0.6 + Number(ppsEl.textContent) * 0.4);
    if (livePPSEl) livePPSEl.textContent = ppsEl.textContent;
  }
}

// ---- WebSocket & packet handling ----
function connect(url) {
  if (ws) { ws.close(); ws = null; }
  try {
    ws = new WebSocket(url);
    termPush('<span class="term-dim">Connecting…</span>');
  } catch (e) {
    console.warn('WS open error', e);
    return;
  }
  ws.onopen = () => {
    if (wsStatusEl) { wsStatusEl.textContent = 'connected'; wsStatusEl.style.color = '#85ffa3'; }
    termPush('<span class="term-kv">WS connected</span> → <span class="term-kv">' + url + '</span>');
  };
  ws.onclose = () => {
    if (wsStatusEl) { wsStatusEl.textContent = 'closed'; wsStatusEl.style.color = '#ff8585'; }
    termPush('<span class="term-dim">WS closed</span>');
  };
  ws.onerror = () => {
    if (wsStatusEl) { wsStatusEl.textContent = 'error'; wsStatusEl.style.color = '#ffb085'; }
    termPush('<span class="term-err">WS error</span>');
  };
  ws.onmessage = (evt) => {
    const handleText = (text) => {
      if (!text) return;
      if (text.startsWith('Received:')) text = text.substring('Received:'.length).trim();
      const preview = text.length > 220 ? text.slice(0, 220) + ' …' : text;
      termPush('<span class="term-dim">' + preview.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span>');
      try { handlePacket(JSON.parse(text)); return; } catch (_) { }
      const parts = text.split(/\n+/);
      for (const p of parts) {
        const s = p.trim(); if (!s) continue;
        try { handlePacket(JSON.parse(s)); } catch (_) { }
      }
    };
    if (typeof evt.data === 'string') handleText(evt.data.trim());
    else if (evt.data instanceof Blob) evt.data.text().then(handleText);
    else if (evt.data instanceof ArrayBuffer) {
      try { handleText(new TextDecoder('utf-8').decode(evt.data)); } catch { }
    }
  };
}

// minimal helpers
function bestUpinfo(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  let best = { snr: -999, rssi: -999 };
  for (const u of arr) {
    if (typeof u.snr === 'number' && u.snr > best.snr) {
      best = { snr: u.snr, rssi: u.rssi };
    }
  }
  return best;
}

function handlePacket(m) {
  if (paused) return;
  const ucnt = Array.isArray(m.upinfo) ? m.upinfo.length : 0;
  const best = bestUpinfo(m.upinfo);
  const snrTxt = best?.snr !== undefined ? best.snr.toFixed(1) + ' dB' : '-';
  const rssiTxt = best?.rssi !== undefined ? best.rssi + ' dBm' : '-';
  const rawDev = (m.DevEui != null && m.DevEui !== '') ? m.DevEui : (m.DevAddr != null ? `ADDR:${m.DevAddr}` : 'UNKNOWN');
  const devS = normalizeDevKey(rawDev);

  termPush(
    `DEV=<span class="term-kv">${devS.slice(-8)}</span> FPort=<span class="term-kv">${fmtVal(m.FPort)}</span> DR=<span class="term-kv">${fmtVal(m.DR)}</span> ` +
    `GW=<span class="term-kv">${ucnt}</span> SNR=<span class="term-kv">${snrTxt}</span> RSSI=<span class="term-kv">${rssiTxt}</span>`
  );

  totalMessages++;
  if (liveTotalEl) liveTotalEl.textContent = String(totalMessages);
  pktCount++; tickPPS();

  // Filters
  if (fportEl.value && m.FPort != null) {
    const allowed = fportEl.value.split(',').map(s => s.trim()).filter(Boolean);
    if (!allowed.includes(String(m.FPort))) return;
  }
  if (drEl.value && m.DR != null) {
    const allowed = drEl.value.split(',').map(s => s.trim()).filter(Boolean);
    if (!allowed.includes(String(m.DR))) return;
  }

  const dev = getDeviceNode(devS);
  if (Array.isArray(m.upinfo) && m.upinfo.length) {
    currentMaxDup = Math.max(currentMaxDup, m.upinfo.length);
    if (liveDupEl) liveDupEl.textContent = currentMaxDup + '×';

    const minSnr = Number(minSnrEl.value);
    for (const u of m.upinfo) {
      // Only visualize if this upinfo is linked to a real gateway
      if (!u.routerid) continue;
      const snr = Number(u.snr ?? 0);
      if (snr < minSnr) continue;
      const rssi = Number(u.rssi ?? -110);
      const gwKey = normalizeGwKey(u.routerid);
      const gw = getGatewayNode(gwKey);
      flashNode(dev); flashNode(gw);
      spawnBeam(dev, gw, snr, rssi, Number(persistEl.value));
    }
  } else {
    // No upinfo/gateway for this packet → do not draw a vertical trail.
    // We keep a subtle flash on the device (optional); remove the next line if undesired.
    flashNode(dev);
  }
}

// ---- Controls ----
document.getElementById('connectBtn').onclick = () => connect(wsEl.value);
document.getElementById('pauseBtn').onclick = (e) => { paused = !paused; e.target.textContent = paused ? 'Resume' : 'Pause'; };
document.getElementById('orbitBtn').onclick = (e) => { orbit = !orbit; e.target.textContent = orbit ? 'Stop' : 'Start'; };

// ---- Animate ----
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  rings.rotation.y += 0.02 * dt;
  stars.rotation.y += 0.002 * dt;

  if (relayoutDirty) { relayout(); relayoutDirty = false; }

  const LERP_ALPHA = 0.08;
  for (const g of devices.values()) {
    if (g.userData.targetPos) g.position.lerp(g.userData.targetPos, LERP_ALPHA);
  }
  for (const g of gateways.values()) {
    if (g.userData.targetPos) g.position.lerp(g.userData.targetPos, LERP_ALPHA);
  }

  // Update beams
  for (const b of Array.from(beams)) {
    const speedScale = Number(speedEl.value);
    const dtLocal = dt * b.speed * speedScale * 0.6;
    b.t += dtLocal;
    const p = b.curve.getPointAt(Math.min(1, b.t));
    b.particle.position.copy(p);
    b.life -= dt;
    const fade = Math.max(0, b.life / b.maxLife);
    b.line.material.opacity = 0.15 + 0.85 * fade;
    b.particle.material.opacity = 0.35 + 0.65 * fade;

    if (b.t >= 1) {
      scene.remove(b.particle);
      b.particle.geometry.dispose(); b.particle.material.dispose();
    }
    if (b.life <= 0) {
      scene.remove(b.line);
      b.line.geometry.dispose(); b.line.material.dispose();
      beams.delete(b);
    }
  }

  // Update flashes
  for (const f of Array.from(flashes)) {
    f.t += dt;
    const k = Math.min(1, f.t / f.dur);
    const intensity = f.base + (1 - k) * (f.peak - f.base);
    if (f.mesh?.material) f.mesh.material.emissiveIntensity = intensity;
    if (f.ring) {
      const s = 0.2 + k * 3.0;
      f.ring.scale.set(s, s, 1);
      f.ring.material.opacity = 0.9 * (1 - k);
    }
    if (k >= 1) {
      if (f.mesh?.material) f.mesh.material.emissiveIntensity = f.base;
      if (f.ring) {
        f.ring.parent?.remove(f.ring);
        f.ring.geometry.dispose(); f.ring.material.dispose();
      }
      flashes.delete(f);
    }
  }

  // Hover labels
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(pickables, false);
  const hitGroup = hits.length ? hits[0].object.parent : null;
  if (hitGroup !== hoveredGroup) {
    setGroupLabelVisible(hoveredGroup, false);
    hoveredGroup = hitGroup;
    setGroupLabelVisible(hoveredGroup, true);
  }

  if (orbit) {
    const t = performance.now() * 0.0001;
    camera.position.x = Math.cos(t) * 220;
    camera.position.z = Math.sin(t) * 220;
    camera.lookAt(0, 20, 0);
  }

  controls.update();
  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});

// ---- boot ----
// Load the overlay mask that constrains gateway placement
try { loadOverlaySVG('./HKUST_Buildings.svg'); } catch (_) { }
try { loadNodeOverlaySVG('./HKUST_Nodes.svg'); } catch (_) { }
// Initialize slider UI (if present) and apply any cached transform
try { initSvgXformUI(); } catch (_) { }
// Restore cached nodes now that the scene/materials are ready
try { restoreCacheAndApply(); } catch (e) {/*ignore*/ }
window.addEventListener('beforeunload', () => { try { saveCache(); } catch (e) { } });
connect(wsEl.value);