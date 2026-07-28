/*
 * Hero scene — the control-plane field (flagship pass, v17).
 * Requests stream as points through a translucent gate ring; most pass,
 * the occasional one deflects in enforcement red. WebGL via vendored
 * Three.js; a 2D-canvas fallback keeps the visual language when WebGL
 * is unavailable; prefers-reduced-motion gets a single still frame.
 * Restraint rules: white fog, one blue, red only for the deflected few.
 */
import * as THREE from '../vendor/three.module.min.js';

const mount = document.getElementById('heroScene');
if (mount) init(mount);

function init(mount) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  try {
    webgl(mount, reduce);
  } catch {
    canvas2d(mount, reduce);
  }
}

/* ---------- WebGL ---------- */
function webgl(mount, reduce) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xffffff, 9, 26);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
  camera.position.set(0, 0.6, 11);

  // ---- the gate: two whisper-thin rings, slowly counter-rotating ----
  const gate = new THREE.Group();
  const ringA = new THREE.Mesh(
    new THREE.TorusGeometry(1.75, 0.010, 8, 128),
    new THREE.MeshBasicMaterial({ color: 0x0066cc, transparent: true, opacity: 0.34 }),
  );
  const ringB = new THREE.Mesh(
    new THREE.TorusGeometry(2.05, 0.0045, 8, 128),
    new THREE.MeshBasicMaterial({ color: 0x0066cc, transparent: true, opacity: 0.12 }),
  );
  gate.add(ringA, ringB);
  // off-axis composition: the gate sits right of the headline, read as an
  // ellipse (not edge-on — edge-on renders as a line through the type)
  gate.position.set(3.5, -1.05, 0);
  gate.rotation.y = 1.18;
  gate.rotation.x = 0.1;
  scene.add(gate);

  // ---- particles ----
  const N = 900;
  const RED_EVERY = 41;
  const SPAN = 30; // x extent of the field
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const meta = []; // per-particle: lane radius, angle, speed, red?
  const BLUE = new THREE.Color(0x2b7fd4);
  const PALE = new THREE.Color(0x9dbfe0);
  const RED = new THREE.Color(0xe0402f);

  for (let i = 0; i < N; i++) {
    const red = i % RED_EVERY === 0;
    const r = 0.35 + Math.pow(Math.random(), 0.7) * 1.5; // bias toward the core
    const a = Math.random() * Math.PI * 2;
    meta.push({ r, a, v: 0.02 + Math.random() * 0.035, red, wob: Math.random() * Math.PI * 2 });
    pos[i * 3] = -SPAN / 2 + Math.random() * SPAN;
    const c = red ? RED : Math.random() < 0.6 ? BLUE : PALE;
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

  const points = new THREE.Points(
    geo,
    new THREE.PointsMaterial({
      size: 0.075,
      map: dotTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      sizeAttenuation: true,
    }),
  );
  scene.add(points);

  // ---- mouse parallax (hero-scoped, lerped) ----
  let tx = 0, ty = 0, cx = 0, cy = 0;
  const hero = mount.closest('section') || mount;
  hero.addEventListener('pointermove', (e) => {
    const r = hero.getBoundingClientRect();
    tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
    ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
  }, { passive: true });

  function size() {
    const w = mount.clientWidth, h = mount.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  size();
  window.addEventListener('resize', size);

  let t = 0;
  function step(dt) {
    t += dt;
    const p = geo.attributes.position.array;
    for (let i = 0; i < N; i++) {
      const m = meta[i];
      let x = p[i * 3] + m.v * dt * 60;
      if (x > SPAN / 2) { x = -SPAN / 2; m.a = Math.random() * Math.PI * 2; }
      // gentle orbital wobble around the flow axis
      const wob = Math.sin(t * 0.7 + m.wob) * 0.12;
      let r = m.r + wob;
      // enforcement: red requests bend away as they near the gate and never cross
      if (m.red) {
        const d = Math.max(0, 1.8 - Math.abs(x - 1.6)); // approaching the gate at x≈3.1
        r += d * 1.7;
        if (x > 2.4) { x = -SPAN / 2; } // recycled before the ring — blocked
      }
      const ang = m.a + t * 0.05;
      p[i * 3] = x;
      p[i * 3 + 1] = -0.75 + Math.cos(ang) * r * 0.55; // field runs beneath the headline
      p[i * 3 + 2] = Math.sin(ang) * r;
    }
    geo.attributes.position.needsUpdate = true;

    gate.rotation.x += dt * 0.05;
    ringB.rotation.z -= dt * 0.1;

    cx += (tx - cx) * 0.04;
    cy += (ty - cy) * 0.04;
    camera.position.x = cx * 0.9;
    camera.position.y = 0.6 - cy * 0.55;
    camera.lookAt(0.6, -0.6, 0);
  }

  if (reduce) { step(0.6); renderer.render(scene, camera); return; }

  let visible = true, raf = null, last = performance.now();
  new IntersectionObserver((es) => {
    visible = es[0].isIntersecting;
    if (visible && raf === null) loop(performance.now());
  }).observe(mount);

  function loop(now) {
    if (!visible) { raf = null; return; }
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }
  loop(last);

  function dotTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.85)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
}

/* ---------- 2D fallback: same field, flat ---------- */
function canvas2d(mount, reduce) {
  const c = document.createElement('canvas');
  mount.appendChild(c);
  const g = c.getContext('2d');
  if (!g) return;
  const N = 140;
  const dots = Array.from({ length: N }, (_, i) => ({
    x: Math.random(), y: 0.18 + Math.random() * 0.64,
    v: 0.0006 + Math.random() * 0.0012,
    s: 1 + Math.random() * 1.6,
    red: i % 41 === 0,
  }));
  function size() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    c.width = mount.clientWidth * dpr;
    c.height = mount.clientHeight * dpr;
  }
  size();
  window.addEventListener('resize', size);
  function draw() {
    g.clearRect(0, 0, c.width, c.height);
    const gx = c.width * 0.62;
    g.strokeStyle = 'rgba(0,102,204,0.35)';
    g.lineWidth = 1;
    g.beginPath();
    g.ellipse(gx, c.height * 0.5, c.width * 0.012, c.height * 0.3, 0, 0, Math.PI * 2);
    g.stroke();
    for (const d of dots) {
      if (!reduce) {
        d.x += d.v;
        if (d.x > 1.02) d.x = -0.02;
        if (d.red && d.x > 0.56) d.x = -0.02;
      }
      g.fillStyle = d.red ? 'rgba(224,64,47,0.7)' : 'rgba(43,127,212,0.55)';
      g.beginPath();
      g.arc(d.x * c.width, d.y * c.height, d.s, 0, Math.PI * 2);
      g.fill();
    }
    if (!reduce) requestAnimationFrame(draw);
  }
  draw();
}
