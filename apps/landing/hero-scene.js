/*
 * Hero scene v2 — the product diagram, alive (goal: concrete, not abstract).
 * Readable request cards stream in from the left (your apps), converge through
 * a glass control-plane gate carrying the Spillway mark, and fan out right
 * into three labeled provider lanes. Every ~10th card is over budget and
 * slams red at the gate. Camera breathes and follows the mouse.
 *
 * Legibility rules: every object is a real UI prop (canvas-textured card with
 * type set in the site's fonts), one Action Blue, red only for enforcement.
 * Fallback: static 2D diagram of the same story. Reduced motion: one frame.
 */
import * as THREE from './vendor/three.module.min.js';

const mount = document.getElementById('heroScene');
if (mount) {
  try {
    webgl(mount);
  } catch {
    fallback(mount);
  }
}

/* ---------- texture props (crisp @2x canvas type) ---------- */
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function cardTexture(lines, opts = {}) {
  const W = 512,
    H = 256,
    c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  roundRect(g, 6, 6, W - 12, H - 12, 26);
  g.fillStyle = opts.bg || 'rgba(255,255,255,0.97)';
  g.fill();
  g.lineWidth = 2.5;
  g.strokeStyle = opts.border || 'rgba(29,29,31,0.12)';
  g.stroke();
  g.fillStyle = opts.dot || '#0066cc';
  g.beginPath();
  g.arc(46, 52, 10, 0, Math.PI * 2);
  g.fill();
  if (opts.label) {
    g.fillStyle = 'rgba(29,29,31,0.45)';
    g.font = '600 22px ui-monospace, Menlo, monospace';
    g.fillText(opts.label.toUpperCase(), 70, 60);
  }
  lines.forEach((ln, i) => {
    g.font = i === 0 ? '600 34px -apple-system, system-ui, sans-serif' : '400 26px ui-monospace, Menlo, monospace';
    g.fillStyle = i === 0 ? opts.ink || '#1d1d1f' : 'rgba(29,29,31,0.55)';
    g.fillText(ln, 46, 118 + i * 44);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function chipTexture(name, tier) {
  const W = 512,
    H = 160,
    c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  roundRect(g, 6, 6, W - 12, H - 12, 30);
  g.fillStyle = 'rgba(22,22,24,0.94)';
  g.fill();
  g.lineWidth = 2.5;
  g.strokeStyle =
    tier === 'cheap' ? 'rgba(84,201,138,0.8)' : tier === 'prem' ? 'rgba(178,124,255,0.8)' : 'rgba(41,151,255,0.8)';
  g.stroke();
  g.fillStyle = tier === 'cheap' ? '#54c98a' : tier === 'prem' ? '#b27cff' : '#2997ff';
  g.beginPath();
  g.arc(52, H / 2, 12, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff';
  g.font = '600 40px ui-monospace, Menlo, monospace';
  g.fillText(name, 86, H / 2 + 14);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function card(tex, w, h) {
  return new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }),
  );
}

/* ---------- WebGL ---------- */
function webgl(mount) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xffffff, 10, 30);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 60);
  camera.position.set(0, 1.4, 13.5);

  // ---- the control plane: a glass slab with the Spillway mark ----
  const gate = new THREE.Group();
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(0.22, 5.2, 4.2),
    new THREE.MeshBasicMaterial({ color: 0xe8eef6, transparent: true, opacity: 0.92 }),
  );
  const slabEdge = new THREE.Mesh(
    new THREE.BoxGeometry(0.26, 5.32, 4.32),
    new THREE.MeshBasicMaterial({ color: 0x0066cc, transparent: true, opacity: 0.3 }),
  );
  const plateC = document.createElement('canvas');
  plateC.width = 1024;
  plateC.height = 224;
  {
    const g = plateC.getContext('2d');
    roundRect(g, 6, 6, 1012, 212, 44);
    g.fillStyle = 'rgba(255,255,255,0.97)';
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0,102,204,0.4)';
    g.stroke();
    g.fillStyle = '#0066cc';
    g.beginPath();
    g.arc(96, 112, 30, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#1d1d1f';
    g.font = '600 72px -apple-system, system-ui, sans-serif';
    g.fillText('Spillway', 152, 138);
    g.font = '500 34px ui-monospace, Menlo, monospace';
    g.fillStyle = 'rgba(29,29,31,0.5)';
    g.fillText('CONTROL PLANE', 512, 128);
  }
  const plateTex = new THREE.CanvasTexture(plateC);
  plateTex.colorSpace = THREE.SRGBColorSpace;
  plateTex.anisotropy = 4;
  const plate = card(plateTex, 3.4, 0.74);
  plate.position.set(0, 3.35, 0);
  gate.add(slab, slabEdge, plate);
  gate.position.set(0, 0.4, 0);
  scene.add(gate);

  // ---- provider lanes on the right ----
  const lanes = [
    { name: 'gpt-4.1-mini', tier: 'mid', z: -3.0, y: 1.9 },
    { name: 'claude-haiku', tier: 'cheap', z: 0, y: 0.4 },
    { name: 'gemini-flash', tier: 'prem', z: 3.0, y: -1.1 },
  ];
  lanes.forEach((ln) => {
    const chip = card(chipTexture(ln.name, ln.tier), 2.3, 0.72);
    chip.position.set(5.8, ln.y, ln.z);
    chip.rotation.y = -0.2;
    ln.chip = chip;
    scene.add(chip);
  });

  // ---- request cards ----
  const REQ_TEXES = [
    cardTexture(['summarize thread', '312 tok · policy: balanced'], { label: 'request' }),
    cardTexture(['classify ticket', '88 tok · policy: cost'], { label: 'request' }),
    cardTexture(['refactor hook', '1.4k tok · policy: quality'], { label: 'request' }),
    cardTexture(['extract invoice', '540 tok · policy: cost'], { label: 'request' }),
  ];
  const BLOCKED_TEX = cardTexture(['batch embed 2M docs', 'budget exceeded · 402'], {
    label: 'blocked',
    border: 'rgba(224,64,47,0.85)',
    dot: '#e0402f',
    ink: '#e0402f',
  });

  const N = 8;
  const cards = [];
  for (let i = 0; i < N; i++) {
    const blocked = i === N - 1;
    const m = card(blocked ? BLOCKED_TEX : REQ_TEXES[i % REQ_TEXES.length], 1.9, 0.95);
    m.userData = {
      t: i / N,
      lane: lanes[i % 3],
      blocked,
      speed: 0.055,
      wob: Math.random() * Math.PI * 2,
    };
    cards.push(m);
    scene.add(m);
  }

  function poseCard(m, t) {
    const u = m.userData;
    if (t < 0.5) {
      // three disciplined sub-lanes all the way in — no crossing, no pileup
      const k = t / 0.5;
      m.position.x = -12.5 + k * 12.1;
      m.position.y = 0.4 + (u.lane.y - 0.4) * 0.35 * (1 - k) + Math.sin(u.wob + t * 9) * 0.04;
      m.position.z = u.lane.z * 0.35 + Math.sin(u.wob) * 0.15;
      m.rotation.y = 0.3 * (1 - k);
      m.rotation.z = 0;
      m.material.opacity = Math.min(1, k * 4);
      m.scale.setScalar(1);
    } else if (u.blocked) {
      const k = (t - 0.5) / 0.5;
      m.position.x = -0.4 - k * 2.6;
      m.position.y = 0.4 - k * k * 3.2;
      m.rotation.z = -k * 0.7;
      m.material.opacity = Math.max(0, 1 - k * 1.4);
    } else {
      const k = (t - 0.5) / 0.5;
      const e = k * k * (3 - 2 * k);
      m.position.x = 0.35 + e * 4.75;
      m.position.y = 0.4 + (u.lane.y - 0.4) * (0.35 + 0.65 * e);
      m.position.z = u.lane.z * (0.35 + 0.65 * e);
      m.rotation.y = -0.25 * e;
      m.rotation.z = 0;
      m.material.opacity = k > 0.82 ? Math.max(0, (1 - k) * 5.5) : 1;
      m.scale.setScalar(1 - e * 0.25);
    }
  }

  let flash = 0;

  // ---- parallax ----
  let tx = 0,
    ty = 0,
    cx = 0,
    cy = 0;
  const hero = mount.closest('section') || mount;
  hero.addEventListener(
    'pointermove',
    (e) => {
      const r = hero.getBoundingClientRect();
      tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
      ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
    },
    { passive: true },
  );

  function size() {
    const w = mount.clientWidth,
      h = mount.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  size();
  window.addEventListener('resize', size);

  let t = 0;
  function step(dt) {
    t += dt;
    for (const m of cards) {
      const u = m.userData;
      u.t += u.speed * dt;
      if (u.t >= 1) {
        u.t = 0;
        u.wob = Math.random() * Math.PI * 2;
      }
      poseCard(m, u.t);
      if (u.blocked && u.t > 0.5 && u.t < 0.54) flash = Math.max(flash, 0.9);
    }
    flash = Math.max(0, flash - dt * 1.8);
    slabEdge.material.color.setHex(flash > 0.05 ? 0xe0402f : 0x0066cc);
    slabEdge.material.opacity = 0.18 + flash * 0.4;
    gate.rotation.y = Math.sin(t * 0.25) * 0.03;
    lanes.forEach((ln, i) => {
      ln.chip.position.y = ln.y + Math.sin(t * 0.7 + i * 2.1) * 0.06;
    });
    cx += (tx - cx) * 0.05;
    cy += (ty - cy) * 0.05;
    camera.position.x = cx * 0.7;
    camera.position.y = 1.4 - cy * 0.4;
    camera.lookAt(0.2, 0.55, 0);
  }
  for (let i = 0; i < 240; i++) step(1 / 60); // pre-roll: field populated on first paint

  if (reduce) {
    renderer.render(scene, camera);
    return;
  }

  let visible = true,
    raf = null,
    last = performance.now();
  new IntersectionObserver((es) => {
    visible = es[0].isIntersecting;
    if (visible && raf === null) loop(performance.now());
  }).observe(mount);

  function loop(now) {
    if (!visible) {
      raf = null;
      return;
    }
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }
  loop(last);
}

/* ---------- no-WebGL: static 2D of the same diagram ---------- */
function fallback(mount) {
  const c = document.createElement('canvas');
  mount.appendChild(c);
  const g = c.getContext('2d');
  if (!g) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  function draw() {
    const W = (c.width = mount.clientWidth * dpr) / dpr;
    const H = (c.height = mount.clientHeight * dpr) / dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const gx = W * 0.52,
      gy = H * 0.55;
    g.strokeStyle = 'rgba(0,102,204,0.4)';
    g.lineWidth = 2;
    roundRect(g, gx - 8, gy - 120, 16, 240, 8);
    g.stroke();
    g.strokeStyle = 'rgba(0,102,204,0.25)';
    for (let i = 0; i < 5; i++) {
      g.beginPath();
      g.moveTo(W * 0.08, gy - 60 + i * 30);
      g.lineTo(gx - 14, gy);
      g.stroke();
      g.beginPath();
      g.moveTo(gx + 14, gy);
      g.lineTo(W * 0.9, gy - 45 + i * 25);
      g.stroke();
    }
  }
  draw();
  window.addEventListener('resize', draw);
}
