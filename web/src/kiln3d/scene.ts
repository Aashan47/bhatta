// The 3D kiln explainer. Loaded with a dynamic import, so three.js never blocks first paint.
// Units are metres. Two kilns sit on a clay ground: an FCBK (oval trench, tall central chimney) and a
// Zigzag (rectangular trench with baffles, chimney at one end). The "10 m" view renders the same scene
// top-down and orthographic into a render target, box-averages it down to Sentinel-2's 10 m grid at
// true scale, and upscales with nearest-neighbour, so the viewer sees what the satellite sees.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export interface KilnSceneOptions {
  reducedMotion: boolean;
  /** Zigzag smoke as a share of FCBK smoke (0.4 for a measured 60% black carbon cut), or null if unknown. */
  smokeRatio: number | null;
  /** Theme colours read from CSS. */
  background: string;
  /** Called every rendered frame with label anchor positions in CSS pixels (or null if behind). */
  onLabels?: (fcbk: { x: number; y: number } | null, zigzag: { x: number; y: number } | null) => void;
}

export interface KilnScene {
  setFire(on: boolean): void;
  /** 0 = orbit view at full detail, 0.5 = top-down at full detail, 1 = top-down at 10 m. */
  setResolution(t: number): void;
  rotateBy(radians: number): void;
  zoomBy(factor: number): void;
  setBackground(css: string): void;
  dispose(): void;
}

const FCBK_X = -55;
const ZIG_X = 55;
const VIEW_W = 260; // metres across the top-down view
const SENSOR_M = 10; // Sentinel-2 visible bands

const COLORS = {
  ground: 0xcaa786,
  brick: 0xa8432a,
  brickDark: 0x86331f,
  trench: 0x3a2e28,
  mound: 0xb48a66,
  chimney: 0x7d3420,
  fire: new THREE.Color(0xffa040),
  smoke: new THREE.Color(0x3d3733),
};

// ---------------------------------------------------------------------------------- paths

interface Path {
  pts: THREE.Vector3[];
  cum: number[];
  length: number;
}

function makePath(pts: THREE.Vector3[], closed = true): Path {
  const all = closed ? [...pts, pts[0]!.clone()] : pts;
  const cum = [0];
  for (let i = 1; i < all.length; i++) cum.push(cum[i - 1]! + all[i]!.distanceTo(all[i - 1]!));
  return { pts: all, cum, length: cum[cum.length - 1]! };
}

function samplePath(p: Path, u: number, out: THREE.Vector3) {
  const d = (((u % 1) + 1) % 1) * p.length;
  let lo = 0;
  let hi = p.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p.cum[mid]! <= d) lo = mid;
    else hi = mid;
  }
  const seg = p.cum[hi]! - p.cum[lo]! || 1;
  return out.lerpVectors(p.pts[lo]!, p.pts[hi]!, (d - p.cum[lo]!) / seg);
}

/** Point on a rounded-corner rectangle perimeter (centred at origin), with its inward normal. */
function rectPerimeter(w: number, h: number, s: number) {
  const per = 2 * (w + h);
  let d = ((s % per) + per) % per;
  if (d < w) return { p: new THREE.Vector2(-w / 2 + d, -h / 2), n: new THREE.Vector2(0, 1) };
  d -= w;
  if (d < h) return { p: new THREE.Vector2(w / 2, -h / 2 + d), n: new THREE.Vector2(-1, 0) };
  d -= h;
  if (d < w) return { p: new THREE.Vector2(w / 2 - d, h / 2), n: new THREE.Vector2(0, -1) };
  d -= w;
  return { p: new THREE.Vector2(-w / 2, h / 2 - d), n: new THREE.Vector2(1, 0) };
}

// ---------------------------------------------------------------------------------- kilns

function brickMaterial() {
  return new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
}

function instanced(geo: THREE.BufferGeometry, mats: THREE.Matrix4[], colors: THREE.Color[]) {
  const mesh = new THREE.InstancedMesh(geo, brickMaterial(), mats.length);
  mats.forEach((m, i) => {
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, colors[i]!);
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function brickColor(rnd: () => number) {
  const c = new THREE.Color(COLORS.brick);
  c.offsetHSL((rnd() - 0.5) * 0.02, (rnd() - 0.5) * 0.08, (rnd() - 0.5) * 0.08);
  return c;
}

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function chimney(height: number, r: number) {
  const g = new THREE.CylinderGeometry(r * 0.72, r, height, 20, 1);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: COLORS.chimney, roughness: 0.85 }));
  m.position.y = height / 2;
  m.castShadow = true;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.8, r * 0.8, 0.8, 20), new THREE.MeshStandardMaterial({ color: 0x2a2421 }));
  cap.position.y = height;
  const grp = new THREE.Group();
  grp.add(m, cap);
  return grp;
}

/** FCBK: oval trench between two oval walls, a raised central mound and a tall chimney in the middle. */
function buildFcbk() {
  const g = new THREE.Group();
  const rnd = seeded(7);
  const A_OUT = 42, B_OUT = 22, A_IN = 31, B_IN = 11;
  // trench floor
  const shape = new THREE.Shape();
  shape.absellipse(0, 0, A_OUT, B_OUT, 0, Math.PI * 2, false, 0);
  const hole = new THREE.Path();
  hole.absellipse(0, 0, A_IN, B_IN, 0, Math.PI * 2, true, 0);
  shape.holes.push(hole);
  const floor = new THREE.Mesh(new THREE.ShapeGeometry(shape, 64), new THREE.MeshStandardMaterial({ color: COLORS.trench, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.05;
  floor.receiveShadow = true;
  g.add(floor);
  // central mound
  const mShape = new THREE.Shape();
  mShape.absellipse(0, 0, A_IN - 0.8, B_IN - 0.8, 0, Math.PI * 2, false, 0);
  const mound = new THREE.Mesh(new THREE.ExtrudeGeometry(mShape, { depth: 1.6, bevelEnabled: false, curveSegments: 48 }), new THREE.MeshStandardMaterial({ color: COLORS.mound, roughness: 1 }));
  mound.rotation.x = -Math.PI / 2;
  mound.receiveShadow = true;
  mound.castShadow = true;
  g.add(mound);
  // walls: boxes along both ellipses
  const mats: THREE.Matrix4[] = [];
  const cols: THREE.Color[] = [];
  const wall = (a: number, b: number, h: number) => {
    const n = Math.round((Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)))) / 2.4);
    for (let i = 0; i < n; i++) {
      const th = (i / n) * Math.PI * 2;
      const x = a * Math.cos(th), z = b * Math.sin(th);
      const ang = Math.atan2(b * Math.cos(th), -a * Math.sin(th));
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, h / 2, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -ang), new THREE.Vector3(1, 1, 1));
      mats.push(m);
      cols.push(brickColor(rnd));
    }
  };
  wall(A_OUT, B_OUT, 3.2);
  wall(A_IN, B_IN, 2.4);
  g.add(instanced(new THREE.BoxGeometry(2.5, 3.2, 1.6), mats, cols));
  // green-brick stacks in the trench: straight rows across it, so air runs straight round the oval
  const sm: THREE.Matrix4[] = [];
  const sc: THREE.Color[] = [];
  const AM = (A_OUT + A_IN) / 2, BM = (B_OUT + B_IN) / 2;
  for (let i = 0; i < 64; i++) {
    const th = (i / 64) * Math.PI * 2;
    if (i % 8 < 2) continue; // the firing zone and unloaded section
    const x = AM * Math.cos(th), z = BM * Math.sin(th);
    const ang = Math.atan2(BM * Math.cos(th), -AM * Math.sin(th));
    sm.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 1.1, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -ang), new THREE.Vector3(1, 1, 1)));
    const c = new THREE.Color(0xb7775a);
    c.offsetHSL(0, 0, (rnd() - 0.5) * 0.06);
    sc.push(c);
  }
  g.add(instanced(new THREE.BoxGeometry(1.8, 2.2, 7), sm, sc));
  const ch = chimney(38, 2.6);
  g.add(ch);
  // air path: one straight loop along the trench centreline
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 160; i++) {
    const th = (i / 160) * Math.PI * 2;
    pts.push(new THREE.Vector3(FCBK_X + AM * Math.cos(th), 2.6, BM * Math.sin(th)));
  }
  g.position.x = FCBK_X;
  return { group: g, path: makePath(pts), chimneyTop: new THREE.Vector3(FCBK_X, 38.5, 0) };
}

/** Zigzag: rectangular trench with baffle walls that leave alternating gaps, chimney at one end. */
function buildZigzag() {
  const g = new THREE.Group();
  const rnd = seeded(11);
  const W_OUT = 84, H_OUT = 40, W_IN = 62, H_IN = 18;
  const floorShape = new THREE.Shape();
  floorShape.moveTo(-W_OUT / 2, -H_OUT / 2);
  floorShape.lineTo(W_OUT / 2, -H_OUT / 2);
  floorShape.lineTo(W_OUT / 2, H_OUT / 2);
  floorShape.lineTo(-W_OUT / 2, H_OUT / 2);
  floorShape.lineTo(-W_OUT / 2, -H_OUT / 2);
  const hole = new THREE.Path();
  hole.moveTo(-W_IN / 2, -H_IN / 2);
  hole.lineTo(-W_IN / 2, H_IN / 2);
  hole.lineTo(W_IN / 2, H_IN / 2);
  hole.lineTo(W_IN / 2, -H_IN / 2);
  hole.lineTo(-W_IN / 2, -H_IN / 2);
  floorShape.holes.push(hole);
  const floor = new THREE.Mesh(new THREE.ShapeGeometry(floorShape), new THREE.MeshStandardMaterial({ color: COLORS.trench, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.05;
  floor.receiveShadow = true;
  g.add(floor);
  const mound = new THREE.Mesh(new THREE.BoxGeometry(W_IN - 1.6, 1.6, H_IN - 1.6), new THREE.MeshStandardMaterial({ color: COLORS.mound, roughness: 1 }));
  mound.position.y = 0.8;
  mound.castShadow = true;
  mound.receiveShadow = true;
  g.add(mound);
  const mats: THREE.Matrix4[] = [];
  const cols: THREE.Color[] = [];
  const rectWall = (w: number, h: number, height: number) => {
    const per = 2 * (w + h);
    const n = Math.round(per / 2.4);
    for (let i = 0; i < n; i++) {
      const { p, n: nn } = rectPerimeter(w, h, (i + 0.5) * (per / n));
      const ang = Math.atan2(nn.x, nn.y);
      mats.push(new THREE.Matrix4().compose(new THREE.Vector3(p.x, height / 2, p.y), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ang), new THREE.Vector3(1, 1, 1)));
      cols.push(brickColor(rnd));
    }
  };
  rectWall(W_OUT, H_OUT, 3.2);
  rectWall(W_IN, H_IN, 2.4);
  g.add(instanced(new THREE.BoxGeometry(2.5, 3.2, 1.6), mats, cols));
  // baffles across the trench with the gap alternating between the inner and outer side
  const WM = (W_OUT + W_IN) / 2, HM = (H_OUT + H_IN) / 2;
  const per = 2 * (WM + HM);
  const STEP = 5.5;
  const nB = Math.floor(per / STEP);
  const bm: THREE.Matrix4[] = [];
  const bc: THREE.Color[] = [];
  const zigPts: THREE.Vector3[] = [];
  const TRENCH = (W_OUT - W_IN) / 2; // 11 m
  for (let i = 0; i < nB; i++) {
    const s = i * STEP;
    const { p, n } = rectPerimeter(WM, HM, s);
    const side = i % 2 === 0 ? 1 : -1;
    const len = TRENCH - 3.2;
    const off = side * 1.6;
    const ang = Math.atan2(n.x, n.y);
    bm.push(
      new THREE.Matrix4().compose(
        new THREE.Vector3(p.x + n.x * off, 1.1, p.y + n.y * off),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ang),
        new THREE.Vector3(1, 1, 1),
      ),
    );
    const c = new THREE.Color(0xb7775a);
    c.offsetHSL(0, 0, (rnd() - 0.5) * 0.06);
    bc.push(c);
    void len;
    // the air squeezes through the gap at the free end of each baffle, and the gaps alternate
    // sides, so the path crosses the trench at every baffle: the zigzag
    zigPts.push(new THREE.Vector3(p.x - n.x * side * (TRENCH / 2 - 1.4), 2.6, p.y - n.y * side * (TRENCH / 2 - 1.4)));
  }
  g.add(instanced(new THREE.BoxGeometry(1.4, 2.2, TRENCH - 3.2), bm, bc));
  const CH_X = W_IN / 2 - 5;
  const ch = chimney(30, 2.2);
  ch.position.x = CH_X;
  g.add(ch);
  g.position.x = ZIG_X;
  return { group: g, path: makePath(zigPts.map((v) => v.add(new THREE.Vector3(ZIG_X, 0, 0)))), chimneyTop: new THREE.Vector3(ZIG_X + CH_X, 30.5, 0) };
}

// ---------------------------------------------------------------------------------- particles

const POINT_VERT = /* glsl */ `
  attribute float aAlpha;
  attribute float aSize;
  uniform float uPersp;
  uniform float uScale;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uPersp > 0.5 ? aSize * uScale / -mv.z : aSize * uScale;
    vAlpha = aAlpha;
  }
`;
const POINT_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uFade;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = vAlpha * uFade * smoothstep(0.5, 0.15, d);
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

function pointCloud(n: number, color: THREE.Color, additive: boolean) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(n), 1));
  geo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(n), 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    uniforms: { uColor: { value: color }, uPersp: { value: 1 }, uScale: { value: 300 }, uFade: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

// ---------------------------------------------------------------------------------- 10 m pass

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
/** Box-average a k x k block of the high-res target into one low-res pixel, like a sensor footprint. */
const AVG_FRAG = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 uSrcSize;
  uniform float uK;
  varying vec2 vUv;
  void main() {
    vec2 base = floor(vUv * uSrcSize / uK) * uK;
    vec3 acc = vec3(0.0);
    float n = 0.0;
    for (int y = 0; y < 8; y++) {
      for (int x = 0; x < 8; x++) {
        if (float(x) >= uK || float(y) >= uK) continue;
        acc += texture2D(tSrc, (base + vec2(float(x), float(y)) + 0.5) / uSrcSize).rgb;
        n += 1.0;
      }
    }
    gl_FragColor = vec4(acc / n, 1.0);
  }
`;
const BLIT_FRAG = /* glsl */ `
  uniform sampler2D tSrc;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tSrc, vUv).rgb;
    // the targets hold linear light (averaged correctly); encode to sRGB for the screen
    gl_FragColor = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
  }
`;

// ---------------------------------------------------------------------------------- scene

export function createKilnScene(container: HTMLElement, opts: KilnSceneOptions): KilnScene {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "low-power", preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.setAttribute("aria-hidden", "true");

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(opts.background);

  const hemi = new THREE.HemisphereLight(0xfff4e6, 0x7a5a40, 1.15);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.9);
  sun.position.set(-90, 160, 110);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -150;
  sc.right = 150;
  sc.top = 110;
  sc.bottom = -110;
  sc.near = 10;
  sc.far = 420;
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  const fog = new THREE.Fog(opts.background, 320, 1100);
  scene.fog = fog;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: COLORS.ground, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const fcbk = buildFcbk();
  const zig = buildZigzag();
  scene.add(fcbk.group, zig.group);

  // fire particles: same speed on both paths; the zigzag path is longer, which is the point
  const FIRE_N = 260;
  const fireF = pointCloud(FIRE_N, COLORS.fire, true);
  const fireZ = pointCloud(FIRE_N, COLORS.fire, true);
  const firePhase = Array.from({ length: FIRE_N }, (_, i) => i / FIRE_N);
  scene.add(fireF, fireZ);

  const SMOKE_BASE = 180;
  const smokeF = pointCloud(SMOKE_BASE, COLORS.smoke, false);
  const smokeZ = pointCloud(SMOKE_BASE, COLORS.smoke, false);
  const zigSmokeCount = opts.smokeRatio == null ? SMOKE_BASE : Math.round(SMOKE_BASE * opts.smokeRatio);
  const smokeSeed = Array.from({ length: SMOKE_BASE }, (_, i) => ({ t0: i / SMOKE_BASE, dx: Math.sin(i * 12.9898) * 0.5 + 0.5, dz: Math.cos(i * 78.233) }));
  scene.add(smokeF, smokeZ);

  // cameras
  const persp = new THREE.PerspectiveCamera(38, 1, 1, 2000);
  persp.position.set(-6, 92, 172);
  const ortho = new THREE.OrthographicCamera(-VIEW_W / 2, VIEW_W / 2, 80, -80, 1, 1000);
  ortho.position.set(0, 500, 0);
  ortho.up.set(0, 0, -1);
  ortho.lookAt(0, 0, 0);

  const controls = new OrbitControls(persp, renderer.domElement);
  controls.target.set(0, 10, 0);
  controls.enableDamping = !opts.reducedMotion;
  controls.dampingFactor = 0.08;
  controls.minDistance = 70;
  controls.maxDistance = 420;
  controls.maxPolarAngle = 1.42;
  controls.enablePan = false;
  controls.update();

  // 10 m pipeline
  const rtHigh = new THREE.WebGLRenderTarget(4, 4, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
  const rtLow = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const avgMat = new THREE.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader: AVG_FRAG, uniforms: { tSrc: { value: rtHigh.texture }, uSrcSize: { value: new THREE.Vector2(4, 4) }, uK: { value: 4 } } });
  const blitMat = new THREE.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader: BLIT_FRAG, uniforms: { tSrc: { value: rtLow.texture } } });
  const quadScene = new THREE.Scene();
  const quad = new THREE.Mesh(quadGeo, avgMat);
  quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  let fireOn = false;
  let t = 0; // resolution slider
  let orbitSaved: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  let width = 1, height = 1;
  let visible = true;
  let raf = 0;
  let disposed = false;
  let dirty = true;
  const clock = new THREE.Clock();
  let elapsed = 0;
  const tmp = new THREE.Vector3();

  let userMoved = false;
  /** Pull the orbit camera back until both kilns (about 210 m across) fit the canvas width. */
  function fitOrbit() {
    if (userMoved || t > 0) return;
    const half = 118;
    const tanH = Math.tan(THREE.MathUtils.degToRad(persp.fov / 2)) * persp.aspect;
    const need = half / tanH + 25;
    const dir = persp.position.clone().sub(controls.target).normalize();
    const dist = Math.max(need, 150);
    persp.position.copy(controls.target).add(dir.multiplyScalar(Math.min(dist, controls.maxDistance)));
    controls.update();
  }

  function resize() {
    const r = container.getBoundingClientRect();
    width = Math.max(1, Math.round(r.width));
    height = Math.max(1, Math.round(r.height));
    renderer.setSize(width, height, false);
    renderer.domElement.style.width = `${width}px`;
    renderer.domElement.style.height = `${height}px`;
    persp.aspect = width / height;
    persp.updateProjectionMatrix();
    const vw = VIEW_W;
    const vh = (VIEW_W * height) / width;
    ortho.left = -vw / 2;
    ortho.right = vw / 2;
    ortho.top = vh / 2;
    ortho.bottom = -vh / 2;
    ortho.updateProjectionMatrix();
    fitOrbit();
    dirty = true;
  }

  function updateParticles(dt: number) {
    if (!opts.reducedMotion) elapsed += dt;
    const fade = THREE.MathUtils.clamp(1 - (t - 0.35) / 0.2, 0, 1); // particles fade out as we go top-down
    const show = fireOn && fade > 0;
    for (const [pts, path] of [
      [fireF, fcbk.path],
      [fireZ, zig.path],
    ] as const) {
      pts.visible = show;
      if (!show) continue;
      const pos = pts.geometry.getAttribute("position") as THREE.BufferAttribute;
      const al = pts.geometry.getAttribute("aAlpha") as THREE.BufferAttribute;
      const sz = pts.geometry.getAttribute("aSize") as THREE.BufferAttribute;
      const speed = 9; // metres per second along the path, equal for both kilns
      for (let i = 0; i < FIRE_N; i++) {
        const u = firePhase[i]! + (elapsed * speed) / path.length;
        samplePath(path, u, tmp);
        pos.setXYZ(i, tmp.x, tmp.y + Math.sin(i * 3.1 + elapsed * 4) * 0.3, tmp.z);
        al.setX(i, 0.55 + 0.45 * Math.sin(i * 1.7 + elapsed * 6) ** 2);
        sz.setX(i, 2.2);
      }
      pos.needsUpdate = al.needsUpdate = sz.needsUpdate = true;
      (pts.material as THREE.ShaderMaterial).uniforms.uFade!.value = fade;
    }
    for (const [pts, top, count] of [
      [smokeF, fcbk.chimneyTop, SMOKE_BASE],
      [smokeZ, zig.chimneyTop, zigSmokeCount],
    ] as const) {
      pts.visible = show;
      if (!show) continue;
      const pos = pts.geometry.getAttribute("position") as THREE.BufferAttribute;
      const al = pts.geometry.getAttribute("aAlpha") as THREE.BufferAttribute;
      const sz = pts.geometry.getAttribute("aSize") as THREE.BufferAttribute;
      for (let i = 0; i < SMOKE_BASE; i++) {
        if (i >= count) {
          al.setX(i, 0);
          continue;
        }
        const s = smokeSeed[i]!;
        const life = (((s.t0 + elapsed / 7) % 1) + 1) % 1;
        pos.setXYZ(i, top.x + life * 14 * s.dx + Math.sin(elapsed + i) * life * 2, top.y + life * 24, top.z + life * 8 * s.dz);
        al.setX(i, (1 - life) * 0.55);
        sz.setX(i, 3 + life * 9);
      }
      pos.needsUpdate = al.needsUpdate = sz.needsUpdate = true;
      (pts.material as THREE.ShaderMaterial).uniforms.uFade!.value = fade;
    }
  }

  function cameraFor(): THREE.Camera {
    if (t <= 0) return persp;
    const s = THREE.MathUtils.smoothstep(Math.min(t / 0.5, 1), 0, 1);
    if (t >= 0.5) return ortho;
    // morph the perspective camera from the saved orbit pose to straight overhead
    const from = orbitSaved ?? { pos: persp.position.clone(), target: controls.target.clone() };
    const dist = VIEW_W / (2 * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2)) * persp.aspect);
    const over = new THREE.Vector3(0, dist, 0.01);
    persp.position.lerpVectors(from.pos, over, s);
    const target = new THREE.Vector3().lerpVectors(from.target, new THREE.Vector3(0, 0, 0), s);
    persp.up.set(0, 1, 0).lerp(new THREE.Vector3(0, 0, -1), s).normalize();
    persp.lookAt(target);
    return persp;
  }

  function projectLabel(cam: THREE.Camera, x: number) {
    const s = Math.min(t / 0.5, 1);
    const p = new THREE.Vector3(x, 46 * (1 - s), -30 * s);
    p.project(cam);
    if (p.z > 1) return null;
    return { x: (p.x * 0.5 + 0.5) * width, y: (-p.y * 0.5 + 0.5) * height };
  }

  function render() {
    const dt = Math.min(clock.getDelta(), 0.05);
    if (t <= 0) controls.update();
    updateParticles(dt);
    const cam = cameraFor();
    scene.fog = t > 0 ? null : fog; // fog only hides the horizon in the orbit view
    const u = THREE.MathUtils.clamp((t - 0.5) / 0.5, 0, 1);
    for (const p of [fireF, fireZ, smokeF, smokeZ]) {
      const m = p.material as THREE.ShaderMaterial;
      m.uniforms.uPersp!.value = cam === persp ? 1 : 0;
      m.uniforms.uScale!.value = cam === persp ? height * renderer.getPixelRatio() * 0.9 : (width * renderer.getPixelRatio()) / VIEW_W;
    }
    if (u <= 0) {
      renderer.setRenderTarget(null);
      renderer.render(scene, cam);
    } else {
      // metres per screen pixel at full detail, then log-interpolate to the 10 m sensor grid
      const fullMpp = VIEW_W / (width * renderer.getPixelRatio());
      const mpp = fullMpp * Math.pow(SENSOR_M / fullMpp, u);
      const lowW = Math.max(2, Math.round(VIEW_W / mpp));
      const lowH = Math.max(2, Math.round((lowW * height) / width));
      const k = Math.min(8, Math.max(1, Math.floor(Math.min(width * renderer.getPixelRatio(), 2048) / lowW)));
      if (rtLow.width !== lowW || rtLow.height !== lowH) rtLow.setSize(lowW, lowH);
      if (rtHigh.width !== lowW * k || rtHigh.height !== lowH * k) rtHigh.setSize(lowW * k, lowH * k);
      renderer.setRenderTarget(rtHigh);
      renderer.render(scene, cam);
      quad.material = avgMat;
      avgMat.uniforms.uSrcSize!.value.set(lowW * k, lowH * k);
      avgMat.uniforms.uK!.value = k;
      renderer.setRenderTarget(rtLow);
      renderer.render(quadScene, quadCam);
      quad.material = blitMat;
      renderer.setRenderTarget(null);
      renderer.render(quadScene, quadCam);
    }
    opts.onLabels?.(projectLabel(cam, FCBK_X), projectLabel(cam, ZIG_X + 4));
    dirty = false;
  }

  let lastChange = 0;
  function animating() {
    if (opts.reducedMotion) return false;
    return fireOn || performance.now() - lastChange < 1200; // let orbit damping settle
  }

  function loop() {
    raf = 0;
    if (disposed || !visible || document.hidden) return;
    if (dirty || animating()) render();
    raf = requestAnimationFrame(loop);
  }
  function kick() {
    dirty = true;
    if (!raf && !disposed) raf = requestAnimationFrame(loop);
  }

  controls.addEventListener("change", () => {
    lastChange = performance.now();
    kick();
  });
  controls.addEventListener("start", () => {
    userMoved = true;
    lastChange = performance.now();
    kick();
  });
  const ro = new ResizeObserver(() => {
    resize();
    kick();
  });
  ro.observe(container);
  const io = new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    if (visible) kick();
  });
  io.observe(container);
  const onVis = () => !document.hidden && kick();
  document.addEventListener("visibilitychange", onVis);

  resize();
  kick();

  return {
    setFire(on) {
      fireOn = on;
      kick();
    },
    setResolution(next) {
      const was = t;
      t = THREE.MathUtils.clamp(next, 0, 1);
      if (was <= 0 && t > 0) orbitSaved = { pos: persp.position.clone(), target: controls.target.clone() };
      if (t <= 0 && orbitSaved) {
        persp.position.copy(orbitSaved.pos);
        persp.up.set(0, 1, 0);
        controls.target.copy(orbitSaved.target);
        orbitSaved = null;
      }
      controls.enabled = t <= 0;
      kick();
    },
    rotateBy(rad) {
      if (t > 0) return;
      userMoved = true;
      const off = persp.position.clone().sub(controls.target);
      off.applyAxisAngle(new THREE.Vector3(0, 1, 0), rad);
      persp.position.copy(controls.target).add(off);
      controls.update();
      kick();
    },
    zoomBy(f) {
      if (t > 0) return;
      userMoved = true;
      const off = persp.position.clone().sub(controls.target).multiplyScalar(f);
      const d = THREE.MathUtils.clamp(off.length(), controls.minDistance, controls.maxDistance);
      persp.position.copy(controls.target).add(off.setLength(d));
      controls.update();
      kick();
    },
    setBackground(css) {
      scene.background = new THREE.Color(css);
      fog.color = new THREE.Color(css);
      kick();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose?.();
      });
      rtHigh.dispose();
      rtLow.dispose();
      avgMat.dispose();
      blitMat.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
