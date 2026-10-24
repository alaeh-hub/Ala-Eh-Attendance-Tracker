import { ReactNode, useEffect, useRef, useState } from "react";
import * as THREE from "three";

/* ------------------------------------------------------------------ */
/* Procedural face.                                                     */
/* Each horizontal ring is a superellipse whose width, front depth and  */
/* back depth come from a simple head profile table. A handful of soft  */
/* gaussian bumps add the brow, eyes, nose, cheeks, lips and chin.      */
/* Units: crown at y = 1.02, eye line at y = 0, chin at y = -1.0.       */
/* ------------------------------------------------------------------ */

const COLS = 120;
const CROWN_ROWS = 24;
const LOWER_ROWS = 80;
const ROWS = CROWN_ROWS + LOWER_ROWS;

const CROWN_Y = 0.55; // where the crown ellipse meets the profile table
const CROWN_H = 0.47;
const HEAD_BOTTOM = -1.04;
const SQUARE = 0.85; // superellipse exponent 2/n: <1 squares the cross-section

const BRAND = new THREE.Color("#f5c000");
const VERIFIED = new THREE.Color("#4ade80");
const HEAD_Y = 0.02;
const CYCLE = 7.5;
const SWEEP = 4.2;

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const sstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const g = (a: number, b: number, ca: number, cb: number, sa: number, sb: number) =>
  Math.exp(-(((a - ca) / sa) ** 2 + ((b - cb) / sb) ** 2));
const spow = (v: number, e: number) => Math.sign(v) * Math.abs(v) ** e;

// [y, half-width, front depth, back depth]
const PROFILE: number[][] = [
  [0.55, 0.72, 0.78, 0.92],
  [0.4, 0.75, 0.8, 0.95],
  [0.2, 0.75, 0.82, 0.94],
  [0.0, 0.74, 0.8, 0.9],
  [-0.2, 0.72, 0.78, 0.84],
  [-0.4, 0.69, 0.78, 0.78],
  [-0.6, 0.62, 0.8, 0.68],
  [-0.8, 0.5, 0.78, 0.56],
  [-0.95, 0.36, 0.72, 0.46], // chin
  [HEAD_BOTTOM, 0.24, 0.58, 0.34],
];

/** Cross-section [halfWidth, front, back] at height y. */
function section(y: number): [number, number, number] {
  if (y >= CROWN_Y) {
    const s = Math.sqrt(Math.max(0, 1 - ((y - CROWN_Y) / CROWN_H) ** 2));
    return [PROFILE[0][1] * s, PROFILE[0][2] * s, PROFILE[0][3] * s];
  }
  let i = 0;
  while (i < PROFILE.length - 2 && y < PROFILE[i + 1][0]) i++;
  const k0 = PROFILE[i];
  const k1 = PROFILE[i + 1];
  const h = k0[0] - k1[0];
  const t = clamp((k0[0] - y) / h, 0, 1);
  const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
  const h10 = t ** 3 - 2 * t ** 2 + t;
  const h01 = -2 * t ** 3 + 3 * t ** 2;
  const h11 = t ** 3 - t ** 2;
  const out: number[] = [];
  for (let c = 1; c <= 3; c++) {
    // tangents per unit of downward y, from the neighbouring keys (zero at the crown joint)
    const prev = PROFILE[i - 1];
    const next = PROFILE[i + 2];
    const m0 = i === 0 ? 0 : (k1[c] - prev[c]) / (prev[0] - k1[0]);
    const m1 = next ? (next[c] - k0[c]) / (k0[0] - next[0]) : (k1[c] - k0[c]) / h;
    out.push(h00 * k0[c] + h10 * h * m0 + h01 * k1[c] + h11 * h * m1);
  }
  return out as [number, number, number];
}

/** Surface sample [x, y, z] for ring angle u at height y. */
function faceSample(u: number, y: number): [number, number, number] {
  const [W, F, B] = section(y);
  const su = Math.sin(u);
  const cu = Math.cos(u);
  const x = W * spow(su, SQUARE);
  let z = (cu >= 0 ? F : B) * spow(cu, SQUARE);

  const ff = sstep(0.15, 0.75, cu); // relief on the front only
  const ax = Math.abs(x);
  let dz = 0;
  dz += 0.12 * g(ax, y, 0, -0.1, 0.07, 0.28); // nose bridge
  dz += 0.16 * g(ax, y, 0, -0.32, 0.12, 0.09); // nose tip
  dz += 0.06 * g(ax, y, 0.32, 0.2, 0.2, 0.06); // brow
  dz -= 0.07 * g(ax, y, 0.31, 0.02, 0.15, 0.09); // eye sockets
  dz += 0.045 * g(ax, y, 0.31, 0.02, 0.08, 0.045); // eyes
  dz += 0.05 * g(ax, y, 0.54, -0.2, 0.2, 0.15); // cheeks
  dz += 0.05 * g(ax, y, 0, -0.58, 0.16, 0.045); // upper lip
  dz += 0.045 * g(ax, y, 0, -0.69, 0.13, 0.045); // lower lip
  dz -= 0.03 * g(ax, y, 0, -0.635, 0.19, 0.014); // mouth line
  dz += 0.06 * g(ax, y, 0, -0.92, 0.15, 0.08); // chin
  z += dz * ff;

  // Simple ears.
  const side = sstep(0.8, 1, Math.abs(su));
  const earX = x + Math.sign(su) * 0.1 * side * g(y, z, -0.1, -0.1, 0.2, 0.16);

  return [earX, y, z];
}

/** Surface point at face-space (x, y), found by bisecting the ring angle. */
function landmark(x: number, y: number): THREE.Vector3 {
  const sign = Math.sign(x) || 1;
  const target = Math.abs(x);
  let lo = 0;
  let hi = Math.PI / 2;
  for (let n = 0; n < 32; n++) {
    const mid = (lo + hi) / 2;
    if (Math.abs(faceSample(mid, y)[0]) < target) lo = mid;
    else hi = mid;
  }
  const [px, py, pz] = faceSample(sign * lo, y);
  return new THREE.Vector3(px, py, pz + 0.015);
}

const LANDMARKS: Record<string, [number, number]> = {
  eyeL: [-0.31, 0.02], eyeR: [0.31, 0.02],
  browL: [-0.31, 0.2], browR: [0.31, 0.2],
  noseTip: [0, -0.32],
  mouthL: [-0.2, -0.64], mouthT: [0, -0.58], mouthR: [0.2, -0.64], mouthB: [0, -0.69],
  chin: [0, -0.93],
  cheekL: [-0.55, -0.2], cheekR: [0.55, -0.2],
};

const NET: Array<{ names: string[]; closed?: boolean }> = [
  { names: ["eyeL", "noseTip", "eyeR"], closed: true },
  { names: ["mouthL", "mouthT", "mouthR", "mouthB"], closed: true },
  { names: ["browL", "eyeL"] },
  { names: ["browR", "eyeR"] },
  { names: ["noseTip", "mouthT"] },
  { names: ["mouthB", "chin"] },
  { names: ["cheekL", "mouthL"] },
  { names: ["cheekR", "mouthR"] },
];
const POINT_COUNT = (COLS + 1) * (ROWS + 1);
const HUD_META = `${Object.keys(LANDMARKS).length} landmarks · ${(POINT_COUNT / 1000).toFixed(1)}k pts`;

/* ------------------------------------------------------------------ */
/* Shaders                                                              */
/* ------------------------------------------------------------------ */

const VERT = /* glsl */ `
  uniform float uTime;
  uniform float uScan;
  uniform float uActive;
  uniform float uFlash;
  uniform float uScale;
  uniform float uBase;
  uniform float uMul;
  uniform float uIsPoint;
  attribute float aSeed;
  varying float vAlpha;
  varying float vScan;
  void main() {
    vec3 n = normalize(normalMatrix * normal);
    vec4 mv0 = modelViewMatrix * vec4(position, 1.0);
    vec3 viewDir = normalize(-mv0.xyz);
    float facing = dot(n, viewDir);
    float front = smoothstep(-0.2, 0.25, facing);
    float rim = pow(1.0 - abs(facing), 2.5);

    float dy = position.y - uScan;
    float scan = exp(-dy * dy * 90.0) * uActive;
    float passed = step(uScan, position.y) * uActive;
    // vertices bunch up at the crown; thin them out so it doesn't blow out under additive blending
    float crown = mix(1.0, smoothstep(0.1, 0.6, length(position.xz)), step(0.5, position.y));

    vScan = scan * crown;
    vAlpha = ((0.10 + 0.38 * rim + 0.12 * passed) * mix(0.3, 1.0, front)
              + scan * 0.55 + uFlash * 0.3) * crown * uMul;

    vec3 p = position + normal * (scan * 0.025 + sin(uTime * 2.0 + aSeed * 6.2831) * 0.004);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(1.5, uScale * (uBase + scan * 0.03 * uIsPoint) / -mv.z);
  }
`;

const FRAG_LINE = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uVerified;
  uniform float uFlash;
  varying float vAlpha;
  varying float vScan;
  void main() {
    vec3 col = mix(uColor, uVerified, uFlash);
    col = mix(col, vec3(1.0, 0.97, 0.85), clamp(vScan, 0.0, 1.0) * 0.7);
    gl_FragColor = vec4(col, clamp(vAlpha, 0.0, 1.0));
  }
`;

const FRAG_POINT = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uVerified;
  uniform float uFlash;
  varying float vAlpha;
  varying float vScan;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.05, d);
    vec3 col = mix(uColor, uVerified, uFlash);
    col = mix(col, vec3(1.0, 0.97, 0.85), clamp(vScan, 0.0, 1.0) * 0.8);
    gl_FragColor = vec4(col, a * clamp(vAlpha, 0.0, 1.0));
  }
`;

const FRAG_LANDMARK = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uVerified;
  uniform float uFlash;
  varying float vAlpha;
  varying float vScan;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float ring = smoothstep(0.5, 0.42, d) * smoothstep(0.3, 0.38, d);
    float core = smoothstep(0.16, 0.1, d);
    float glow = exp(-d * 7.0) * 0.55;
    float a = clamp(ring * (0.4 + vScan) + core + glow, 0.0, 1.0);
    vec3 col = mix(uColor, uVerified, uFlash);
    col = mix(col, vec3(1.0), core * 0.6 + vScan * 0.5);
    gl_FragColor = vec4(col, a * clamp(vAlpha, 0.0, 1.0));
  }
`;

/* ------------------------------------------------------------------ */
/* Scene                                                                */
/* ------------------------------------------------------------------ */

interface Hud {
  status: HTMLElement | null;
  match: HTMLElement | null;
  bar: HTMLElement | null;
}

function buildScene(mount: HTMLDivElement, hud: Hud, reduceMotion: boolean): () => void {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  canvas.style.cssText = "display:block;width:100%;height:100%";
  mount.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 50);
  camera.position.set(0, 0, 6);

  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(o: T): T => (disposables.push(o), o);

  /* shared uniforms (the same {value} objects feed every material) */
  const shared: Record<string, THREE.IUniform> = {
    uTime: { value: 0 },
    uScan: { value: 10 },
    uActive: { value: 0 },
    uFlash: { value: 0 },
    uScale: { value: 600 },
    uColor: { value: BRAND },
    uVerified: { value: VERIFIED },
  };
  const material = (frag: string, extra: { uBase: number; uMul: number; uIsPoint: number }) =>
    track(
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: frag,
        uniforms: {
          ...shared,
          uBase: { value: extra.uBase },
          uMul: { value: extra.uMul },
          uIsPoint: { value: extra.uIsPoint },
        },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );

  const head = new THREE.Group();
  head.position.y = HEAD_Y;
  scene.add(head);

  /* --- surface grid --- */
  // Rows are spaced by angle over the crown (so the cap is evenly tessellated) and evenly in y below it.
  const rowY: number[] = [];
  for (let k = 0; k < CROWN_ROWS; k++) rowY.push(CROWN_Y + CROWN_H * Math.cos((k / CROWN_ROWS) * (Math.PI / 2)));
  for (let k = 0; k <= LOWER_ROWS; k++) rowY.push(CROWN_Y + (HEAD_BOTTOM - CROWN_Y) * (k / LOWER_ROWS));

  const pos = new Float32Array(POINT_COUNT * 3);
  const seed = new Float32Array(POINT_COUNT);
  const idx = (i: number, j: number) => j * (COLS + 1) + i;
  for (let j = 0; j <= ROWS; j++) {
    for (let i = 0; i <= COLS; i++) {
      const [x, y, z] = faceSample((i / COLS) * Math.PI * 2, rowY[j]);
      const k = idx(i, j);
      pos.set([x, y, z], k * 3);
      seed[k] = Math.random();
    }
  }
  const tris: number[] = [];
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const a = idx(i, j), b = idx(i + 1, j), c = idx(i, j + 1), d = idx(i + 1, j + 1);
      tris.push(a, c, b, b, c, d);
    }
  }
  const baseGeo = track(new THREE.BufferGeometry());
  baseGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  baseGeo.setIndex(tris);
  baseGeo.computeVertexNormals();
  const posAttr = baseGeo.getAttribute("position");
  const normAttr = baseGeo.getAttribute("normal");
  const seedAttr = new THREE.BufferAttribute(seed, 1);

  const edges: number[] = [];
  for (let j = 3; j < ROWS; j += 3) for (let i = 0; i < COLS; i++) edges.push(idx(i, j), idx(i + 1, j));
  for (let i = 0; i < COLS; i += 6) for (let j = 0; j < ROWS; j++) edges.push(idx(i, j), idx(i, j + 1));
  const lineGeo = track(new THREE.BufferGeometry());
  lineGeo.setAttribute("position", posAttr);
  lineGeo.setAttribute("normal", normAttr);
  lineGeo.setAttribute("aSeed", seedAttr);
  lineGeo.setIndex(edges);
  const wire = new THREE.LineSegments(lineGeo, material(FRAG_LINE, { uBase: 0, uMul: 1, uIsPoint: 0 }));
  wire.frustumCulled = false;
  head.add(wire);

  const pointGeo = track(new THREE.BufferGeometry());
  pointGeo.setAttribute("position", posAttr);
  pointGeo.setAttribute("normal", normAttr);
  pointGeo.setAttribute("aSeed", seedAttr);
  const points = new THREE.Points(pointGeo, material(FRAG_POINT, { uBase: 0.019, uMul: 1.8, uIsPoint: 1 }));
  points.frustumCulled = false;
  head.add(points);

  /* --- landmarks + net --- */
  const names = Object.keys(LANDMARKS);
  const lmPos = new Float32Array(names.length * 3);
  const lmNorm = new Float32Array(names.length * 3);
  const lmSeed = new Float32Array(names.length);
  const byName = new Map<string, THREE.Vector3>();
  names.forEach((name, k) => {
    const p = landmark(...LANDMARKS[name]);
    byName.set(name, p);
    lmPos.set([p.x, p.y, p.z], k * 3);
    const n = new THREE.Vector3(p.x, 0, p.z).normalize();
    lmNorm.set([n.x, n.y, n.z], k * 3);
    lmSeed[k] = Math.random();
  });
  const lmGeo = track(new THREE.BufferGeometry());
  lmGeo.setAttribute("position", new THREE.BufferAttribute(lmPos, 3));
  lmGeo.setAttribute("normal", new THREE.BufferAttribute(lmNorm, 3));
  lmGeo.setAttribute("aSeed", new THREE.BufferAttribute(lmSeed, 1));
  const lm = new THREE.Points(lmGeo, material(FRAG_LANDMARK, { uBase: 0.075, uMul: 4, uIsPoint: 1 }));
  lm.frustumCulled = false;
  head.add(lm);

  const netPos: number[] = [];
  const netNorm: number[] = [];
  const pushSeg = (a: THREE.Vector3, b: THREE.Vector3) => {
    for (const p of [a, b]) {
      netPos.push(p.x, p.y, p.z);
      const n = new THREE.Vector3(p.x, 0, p.z).normalize();
      netNorm.push(n.x, n.y, n.z);
    }
  };
  for (const { names: chain, closed } of NET) {
    const pts = chain.map((n) => byName.get(n)!);
    for (let k = 0; k < pts.length - 1; k++) pushSeg(pts[k], pts[k + 1]);
    if (closed) pushSeg(pts[pts.length - 1], pts[0]);
  }
  const netGeo = track(new THREE.BufferGeometry());
  netGeo.setAttribute("position", new THREE.Float32BufferAttribute(netPos, 3));
  netGeo.setAttribute("normal", new THREE.Float32BufferAttribute(netNorm, 3));
  netGeo.setAttribute("aSeed", new THREE.Float32BufferAttribute(new Float32Array(netPos.length / 3), 1));
  const net = new THREE.LineSegments(netGeo, material(FRAG_LINE, { uBase: 0, uMul: 3.2, uIsPoint: 0 }));
  net.frustumCulled = false;
  head.add(net);

  /* --- scan ring: re-traced each frame so it hugs the face at the current height --- */
  const RING_N = 200;
  const ringArr = new Float32Array(RING_N * 3);
  const ringAttr = new THREE.BufferAttribute(ringArr, 3);
  const ringGeo = track(new THREE.BufferGeometry());
  ringGeo.setAttribute("position", ringAttr);
  const ringMat = track(new THREE.LineBasicMaterial({ color: 0xfff4c7, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false }));
  const ring = new THREE.LineLoop(ringGeo, ringMat);
  const ringHalo = new THREE.LineLoop(ringGeo, track(new THREE.LineBasicMaterial({ color: BRAND, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false })));
  ring.frustumCulled = ringHalo.frustumCulled = false;
  ring.scale.set(1.015, 1, 1.015);
  ringHalo.scale.set(1.1, 1, 1.1);
  head.add(ring, ringHalo);

  /* --- pedestal pulses, orbit rings, dust --- */
  const circlePts: THREE.Vector3[] = [];
  for (let k = 0; k < 160; k++) {
    const a = (k / 160) * Math.PI * 2;
    circlePts.push(new THREE.Vector3(Math.sin(a), 0, Math.cos(a)));
  }
  const circleGeo = track(new THREE.BufferGeometry().setFromPoints(circlePts));
  const pulses: THREE.LineLoop[] = [];
  for (let k = 0; k < 3; k++) {
    const m = track(new THREE.LineBasicMaterial({ color: BRAND, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    const l = new THREE.LineLoop(circleGeo, m);
    l.position.y = HEAD_BOTTOM + HEAD_Y - 0.2;
    pulses.push(l);
    scene.add(l);
  }

  const ORBIT_R = 1.5;
  const orbitPts: THREE.Vector3[] = [];
  for (let k = 0; k <= 180; k++) {
    const a = (k / 180) * Math.PI * 2;
    orbitPts.push(new THREE.Vector3(Math.cos(a) * ORBIT_R, 0, Math.sin(a) * ORBIT_R));
  }
  const orbitGeo = track(new THREE.BufferGeometry().setFromPoints(orbitPts));
  const makeOrbit = (tiltX: number, tiltZ: number, opacity: number) => {
    const line = new THREE.Line(orbitGeo, track(new THREE.LineDashedMaterial({ color: BRAND, dashSize: 0.06, gapSize: 0.08, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false })));
    line.computeLineDistances();
    const holder = new THREE.Group();
    holder.rotation.set(tiltX, 0, tiltZ);
    holder.add(line);
    const dotGeo = track(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(ORBIT_R, 0, 0)]));
    const dot = new THREE.Points(dotGeo, track(new THREE.PointsMaterial({ color: 0xfff4c7, size: 0.07, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
    const spinner = new THREE.Group();
    spinner.add(dot);
    holder.add(spinner);
    scene.add(holder);
    return { holder, spinner };
  };
  const orbits = [makeOrbit(1.25, 0.3, 0.28), makeOrbit(-0.9, -0.5, 0.18)];

  const dustN = 520;
  const dustPos = new Float32Array(dustN * 3);
  for (let k = 0; k < dustN; k++) {
    const r = 1.9 + Math.random() * 2.4;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    dustPos.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.8, r * Math.sin(ph) * Math.sin(th)], k * 3);
  }
  const dustGeo = track(new THREE.BufferGeometry());
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, track(new THREE.PointsMaterial({ color: BRAND, size: 0.018, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false })));
  scene.add(dust);

  /* --- sizing --- */
  const fov = (camera.fov * Math.PI) / 180;
  const resize = () => {
    const w = mount.clientWidth;
    const h = mount.clientHeight;
    if (w < 2 || h < 2) return false;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const dH = 1.45 / Math.tan(fov / 2);
    const dW = 1.6 / (Math.tan(fov / 2) * camera.aspect);
    camera.position.z = Math.max(dH, dW);
    camera.updateProjectionMatrix();
    shared.uScale.value = canvas.height / (2 * Math.tan(fov / 2));
    return true;
  };

  /* --- pointer parallax --- */
  let px = 0;
  let py = 0;
  let lastMove = -10;
  const onMove = (e: PointerEvent) => {
    px = (e.clientX / window.innerWidth - 0.5) * 2;
    py = (e.clientY / window.innerHeight - 0.5) * 2;
    lastMove = performance.now() / 1000;
  };
  window.addEventListener("pointermove", onMove, { passive: true });

  /* --- frame --- */
  let yaw = -0.3;
  let pitch = 0;
  let last = performance.now() / 1000;
  let elapsed = reduceMotion ? 2.2 : 0;
  let hudClock = 0;
  let raf = 0;

  const frame = (now: number, dt: number) => {
    elapsed += dt;
    const ct = elapsed % CYCLE;
    const sweeping = ct < SWEEP;
    const p = sweeping ? ct / SWEEP : 1;
    const eased = 0.5 - 0.5 * Math.cos(Math.PI * p);
    const scanY = 0.96 - eased * 2.0;
    const k = sweeping ? 0 : (ct - SWEEP) / (CYCLE - SWEEP);
    const flash = sweeping ? 0 : sstep(0, 0.12, k) * (1 - sstep(0.65, 1, k));

    shared.uTime.value = elapsed;
    shared.uScan.value = scanY;
    shared.uActive.value = sweeping ? 1 : 0;
    shared.uFlash.value = flash;

    // head orientation: pointer-driven while the cursor is active, gentle sway otherwise
    const pointerAge = now - lastMove;
    const follow = reduceMotion ? 0 : 1 - sstep(2.5, 4, pointerAge);
    const targetYaw = follow * px * 0.75 + (1 - follow) * Math.sin(elapsed * 0.45) * 0.4 - 0.1;
    const targetPitch = follow * py * 0.22 + (1 - follow) * Math.sin(elapsed * 0.33 + 1) * 0.04;
    const ease = 1 - Math.exp(-dt * 4);
    yaw += (targetYaw - yaw) * ease;
    pitch += (targetPitch - pitch) * ease;
    head.rotation.set(pitch, yaw, 0);
    head.position.y = HEAD_Y + Math.sin(elapsed * 0.9) * 0.025;

    // scan ring traces the face cross-section at the scan height
    ring.visible = ringHalo.visible = sweeping;
    if (sweeping) {
      for (let n = 0; n < RING_N; n++) {
        const [x, y, z] = faceSample((n / RING_N) * Math.PI * 2, scanY);
        ringArr[n * 3] = x;
        ringArr[n * 3 + 1] = y;
        ringArr[n * 3 + 2] = z;
      }
      ringAttr.needsUpdate = true;
    }

    pulses.forEach((l, n) => {
      const f = (elapsed * 0.28 + n / pulses.length) % 1;
      l.scale.setScalar(0.5 + f * 1.1);
      (l.material as THREE.LineBasicMaterial).opacity = (1 - f) * (1 - f) * 0.55;
    });
    orbits.forEach((o, n) => {
      o.spinner.rotation.y = elapsed * (n ? -0.7 : 0.9);
      o.holder.rotation.y = elapsed * 0.08 * (n ? -1 : 1);
    });
    dust.rotation.y = elapsed * 0.04;

    renderer.render(scene, camera);

    hudClock += dt;
    if (hudClock > 0.1) {
      hudClock = 0;
      if (hud.status) {
        hud.status.textContent = sweeping ? (p < 0.34 ? "MAPPING GEOMETRY" : p < 0.7 ? "EXTRACTING LANDMARKS" : "BUILDING EMBEDDING") : "SCAN COMPLETE";
        hud.status.dataset.done = sweeping ? "0" : "1";
      }
      if (hud.match) hud.match.textContent = `${(eased * 98.7).toFixed(1)}%`;
      if (hud.bar) hud.bar.style.width = `${eased * 100}%`;
    }
  };

  let ro: ResizeObserver | undefined;
  if (reduceMotion) {
    // One static frame, redrawn on resize.
    ro = new ResizeObserver(() => resize() && frame(performance.now() / 1000, 0));
    ro.observe(mount);
  } else {
    ro = new ResizeObserver(() => resize());
    ro.observe(mount);
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = performance.now() / 1000;
      const dt = Math.min(0.05, now - last);
      last = now;
      if (mount.clientWidth > 1) frame(now, dt);
    };
    raf = requestAnimationFrame(loop);
  }
  resize();

  return () => {
    cancelAnimationFrame(raf);
    ro?.disconnect();
    window.removeEventListener("pointermove", onMove);
    disposables.forEach((d) => d.dispose());
    renderer.dispose();
    canvas.remove();
  };
}

/* ------------------------------------------------------------------ */
/* React wrapper + HUD                                                  */
/* ------------------------------------------------------------------ */

export default function FaceScan3D({ fallback }: { fallback: ReactNode }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const matchRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    try {
      return buildScene(mount, { status: statusRef.current, match: matchRef.current, bar: barRef.current }, reduce);
    } catch {
      // No WebGL (old GPU, blocked, headless): show the static graphic instead.
      setFailed(true);
    }
  }, []);

  if (failed) return <>{fallback}</>;

  return (
    <div className="relative h-full w-full" aria-hidden="true">
      <div ref={mountRef} className="absolute inset-0" />

      {/* HUD */}
      <div className="pointer-events-none absolute inset-0 font-mono text-[10px] uppercase tracking-[0.18em] text-brand-400/80">
        <span className="absolute left-0 top-0 h-5 w-5 border-l-2 border-t-2 border-brand-500/70" />
        <span className="absolute right-0 top-0 h-5 w-5 border-r-2 border-t-2 border-brand-500/70" />
        <span className="absolute bottom-0 left-0 h-5 w-5 border-b-2 border-l-2 border-brand-500/70" />
        <span className="absolute bottom-0 right-0 h-5 w-5 border-b-2 border-r-2 border-brand-500/70" />

        <div className="absolute left-4 top-3 flex items-center gap-2">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-400" />
          Live
        </div>
        <div className="absolute right-4 top-3 text-neutral-500">{HUD_META}</div>

        <div className="absolute inset-x-4 bottom-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <span ref={statusRef} className="text-brand-400 data-[done='1']:text-emerald-400">Mapping geometry</span>
            <span ref={matchRef} className="tabular-nums text-neutral-300">0.0%</span>
          </div>
          <div className="h-px w-full bg-white/10">
            <span ref={barRef} className="block h-px w-0 bg-brand-400 shadow-[0_0_8px_rgba(245,192,0,.8)]" />
          </div>
        </div>
      </div>
    </div>
  );
}
