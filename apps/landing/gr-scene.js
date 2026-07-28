/*
 * Guardrail scene v2 — concrete props, directed like film (goal pass).
 * The payload is the actual prompt card (readable copy + tags). Models are
 * labeled badge chips towing the card. The gate is an archway with a real
 * scoreboard: "QUALITY GATE · accept ≥ 0.85" on the lintel, the live score
 * on the right pillar. Verdicts stamp onto the card — red REJECTED 0.62,
 * green 0.94 SHIPPED. Camera keyframed per beat; scroll is the timeline.
 * DOM actors remain the no-WebGL fallback; HUD (captions/telemetry) stays DOM.
 */
import * as THREE from './vendor/three.module.min.js';

// (entry point at the bottom — the const texture helpers must initialize first)

/* ---------- canvas props ---------- */
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function tex(draw, w = 512, h = 256) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function card(t, w, h) {
  return new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: t, transparent: true, side: THREE.DoubleSide }),
  );
}

const promptTex = () =>
  tex((g, W, H) => {
    roundRect(g, 6, 6, W - 12, H - 12, 28);
    g.fillStyle = 'rgba(28,28,30,0.96)';
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(255,255,255,0.22)';
    g.stroke();
    g.fillStyle = 'rgba(41,151,255,0.9)';
    g.font = '600 24px ui-monospace, Menlo, monospace';
    g.fillText('INCOMING PROMPT', 44, 62);
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.textAlign = 'right';
    g.fillText('1,284 TOK', W - 44, 62);
    g.textAlign = 'left';
    g.fillStyle = '#f2f2f4';
    g.font = '600 33px -apple-system, system-ui, sans-serif';
    g.fillText('“Summarize this 40-page vendor', 44, 122);
    g.fillText('contract and flag every liability.”', 44, 166);
    const tags = [
      ['legal', 'rgba(255,255,255,0.55)'],
      ['long-context', 'rgba(255,255,255,0.55)'],
      ['high-stakes', '#ffcf6b'],
    ];
    let x = 44;
    g.font = '500 22px ui-monospace, Menlo, monospace';
    tags.forEach(([t2, col]) => {
      const w2 = g.measureText(t2).width + 36;
      roundRect(g, x, 196, w2, 40, 20);
      g.strokeStyle = col === '#ffcf6b' ? 'rgba(224,160,32,0.7)' : 'rgba(255,255,255,0.25)';
      g.lineWidth = 2;
      g.stroke();
      g.fillStyle = col;
      g.fillText(t2, x + 18, 224);
      x += w2 + 14;
    });
  }, 640, 288);

const badgeTex = (name, tierLabel, color) =>
  tex((g, W, H) => {
    roundRect(g, 6, 6, W - 12, H - 12, 30);
    g.fillStyle = 'rgba(22,22,24,0.96)';
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = color;
    g.stroke();
    g.fillStyle = color;
    g.beginPath();
    g.arc(54, H / 2, 13, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.font = '600 42px ui-monospace, Menlo, monospace';
    g.fillText(name, 92, H / 2 - 4);
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.font = '500 24px ui-monospace, Menlo, monospace';
    g.fillText(tierLabel, 92, H / 2 + 36);
  }, 640, 170);

const lintelTex = () =>
  tex((g, W, H) => {
    roundRect(g, 6, 6, W - 12, H - 12, 24);
    g.fillStyle = 'rgba(24,24,26,0.97)';
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.stroke();
    g.fillStyle = '#f2f2f4';
    g.font = '600 40px ui-monospace, Menlo, monospace';
    g.textAlign = 'center';
    g.fillText('QUALITY GATE', W / 2, 74);
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.font = '500 30px ui-monospace, Menlo, monospace';
    g.fillText('accept ≥ 0.85', W / 2, 122);
  }, 768, 160);

const scoreTex = (text, color) =>
  tex((g, W, H) => {
    roundRect(g, 6, 6, W - 12, H - 12, 24);
    g.fillStyle = 'rgba(24,24,26,0.97)';
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = color;
    g.stroke();
    g.fillStyle = color;
    g.font = '600 84px ui-monospace, Menlo, monospace';
    g.textAlign = 'center';
    g.fillText(text, W / 2, H / 2 + 30);
  }, 384, 192);

const stampTex = (line1, line2, color) =>
  tex((g, W, H) => {
    roundRect(g, 10, 10, W - 20, H - 20, 18);
    g.fillStyle = 'rgba(20,20,22,0.9)';
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = color;
    g.stroke();
    g.fillStyle = color;
    g.textAlign = 'center';
    g.font = '700 64px ui-monospace, Menlo, monospace';
    g.fillText(line1, W / 2, 86);
    g.font = '700 40px ui-monospace, Menlo, monospace';
    g.fillText(line2, W / 2, 140);
  }, 448, 176);

/* ---------- the shot ---------- */
function build(pin) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const mount = document.createElement('div');
  mount.className = 'gr-stage';
  mount.appendChild(renderer.domElement);
  pin.insertBefore(mount, pin.querySelector('.gr-head'));

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x131315, 12, 46);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 80);

  const C = {
    green: '#54c98a',
    purple: '#b27cff',
    amber: '#ffcf6b',
    red: '#e0402f',
    grey: 'rgba(255,255,255,0.4)',
  };

  // ---- set: floor + runway ----
  const grid = new THREE.GridHelper(140, 70, 0x2c2c30, 0x232326);
  grid.position.y = -2.2;
  scene.add(grid);
  const runway = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 0.06),
    new THREE.MeshBasicMaterial({ color: 0x3a4a5c, transparent: true, opacity: 0.8 }),
  );
  runway.rotation.x = -Math.PI / 2;
  runway.position.set(-7, -2.19, 0);
  scene.add(runway);

  // ---- set: the archway gate ----
  const gate = new THREE.Group();
  const pillarGeo = new THREE.BoxGeometry(0.34, 6.2, 0.34);
  const pillarMat = () => new THREE.MeshBasicMaterial({ color: 0x3c3c40 });
  const pillarL = new THREE.Mesh(pillarGeo, pillarMat());
  const pillarR = new THREE.Mesh(pillarGeo, pillarMat());
  pillarL.position.set(0, 0.9, -2.6);
  pillarR.position.set(0, 0.9, 2.6);
  const lintel = card(lintelTex(), 5.9, 1.22);
  lintel.position.set(0, 4.35, 0);
  lintel.rotation.y = -Math.PI / 2; // face the camera side (-x)
  const scorePlate = card(scoreTex('— · —', C.grey), 2.2, 1.1);
  // High + wide of the payload's z=0 lane: at the scoring beats the camera sits
  // low on -x and the plate used to overlap the prompt card mid-frame.
  scorePlate.position.set(0, 3.15, 4.5);
  scorePlate.rotation.y = -Math.PI / 2; // face the camera side (-x)
  const field = new THREE.Mesh(
    new THREE.PlaneGeometry(4.9, 6.0),
    new THREE.MeshBasicMaterial({ color: 0x8899aa, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }),
  );
  field.rotation.y = Math.PI / 2;
  field.position.y = 0.9;
  const beam = new THREE.Mesh(
    new THREE.PlaneGeometry(4.9, 0.06),
    new THREE.MeshBasicMaterial({ color: 0xffcf6b, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }),
  );
  beam.rotation.y = Math.PI / 2;
  beam.position.y = 0.9;
  gate.add(pillarL, pillarR, lintel, scorePlate, field, beam);
  scene.add(gate);

  // score plate states (texture swaps)
  const SCORES = {
    idle: scoreTex('— · —', C.grey),
    scoring: scoreTex('· · ·', C.amber),
    fail: scoreTex('0.62 ✕', C.red),
    pass: scoreTex('0.94 ✓', C.green),
  };
  function setScore(key) {
    if (scorePlate.material.map !== SCORES[key]) {
      scorePlate.material.map = SCORES[key];
      scorePlate.material.needsUpdate = true;
    }
  }

  // ---- actors ----
  const prompt = card(promptTex(), 3.4, 1.53);
  scene.add(prompt);

  const smBadge = card(badgeTex('claude-3.5-haiku', 'CHEAP · FIRST ATTEMPT', C.green), 2.7, 0.72);
  const lgBadge = card(badgeTex('claude-3.7-sonnet', 'PREMIUM · ESCALATION', C.purple), 2.7, 0.72);
  scene.add(smBadge, lgBadge);

  const failStamp = card(stampTex('0.62', 'REJECTED', C.red), 1.7, 0.66);
  const passStamp = card(stampTex('0.94', 'SHIPPED', C.green), 1.7, 0.66);
  failStamp.rotation.z = -0.12;
  passStamp.rotation.z = 0.1;
  scene.add(failStamp, passStamp);

  // ---- helpers ----
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const seg = (p, a, b) => clamp((p - a) / (b - a), 0, 1);
  const smooth = (x) => x * x * (3 - 2 * x);
  const lerp = (a, b, x) => a + (b - a) * x;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  const SHOTS = [
    [0.0, 0.16, V(-19, 5, 17), V(-13, 3.2, 13), V(-9, 1, 0), V(-7.5, 1, 0)],
    [0.16, 0.4, V(-13, 3.2, 13), V(-6.5, 2.2, 10), V(-7.5, 1, 0), V(-2, 1, 0)],
    [0.4, 0.58, V(-6.5, 2.2, 10), V(-5.6, 2.1, 9.6), V(-2, 1, 0), V(-0.8, 1.2, 0)],
    [0.58, 0.82, V(-5, 1.8, 8.6), V(-7.5, 3, 11), V(-0.8, 1.2, 0), V(-4, 1.2, 0)],
    [0.82, 1.0, V(-7.5, 3, 11), V(-1.2, 2.8, 14.5), V(-4, 1.2, 0), V(7, 1, 0)], // stay on the near side — the plates keep facing us
  ];
  function poseCamera(p) {
    let s = SHOTS[0];
    for (const sh of SHOTS) if (p >= sh[0]) s = sh;
    const k = smooth(seg(p, s[0], s[1]));
    camera.position.lerpVectors(s[2], s[3], k);
    camera.lookAt(new THREE.Vector3().lerpVectors(s[4], s[5], k));
  }

  let spin = 0;
  function render(p) {
    if (!reduce) spin = p * 12;

    // ---- payload trajectory ----
    const arrive = smooth(seg(p, 0.0, 0.16));
    const run1 = smooth(seg(p, 0.22, 0.42));
    const recoil = Math.sin(seg(p, 0.44, 0.56) * Math.PI);
    const handoff = smooth(seg(p, 0.6, 0.68));
    const run2 = smooth(seg(p, 0.68, 0.86));
    const exit = smooth(seg(p, 0.86, 1.0));

    let px = lerp(-15, -8.5, arrive);
    px = lerp(px, -1.6, run1);
    px -= recoil * 2.4;
    if (handoff > 0) px = lerp(px, -6.2, handoff);
    if (run2 > 0) px = lerp(-6.2, -0.8, run2);
    if (exit > 0) px = lerp(-0.8, 10.5, exit);
    const py = 1.15 + Math.sin(spin * 0.6) * 0.07;
    prompt.position.set(px, py, 0);
    prompt.rotation.y = 0.1 * Math.sin(spin * 0.3);

    // badges tow beneath the card
    const smIn = smooth(seg(p, 0.16, 0.24));
    const smOut = seg(p, 0.56, 0.64);
    smBadge.visible = p > 0.14 && p < 0.66;
    smBadge.position.set(px, py - 1.15, 0.02);
    smBadge.material.opacity = smIn * (1 - smOut);

    const lgIn = smooth(seg(p, 0.58, 0.68));
    lgBadge.visible = p > 0.56;
    lgBadge.position.set(px, py - 1.15, 0.02);
    lgBadge.material.opacity = lgIn;

    // verdict stamps ride the card
    const failIn = seg(p, 0.5, 0.545);
    const failOut = seg(p, 0.6, 0.68);
    failStamp.visible = failIn > 0 && failOut < 1;
    failStamp.position.set(px + 0.95, py + 0.42, 0.05);
    failStamp.material.opacity = failIn * (1 - failOut);
    failStamp.scale.setScalar(lerp(1.7, 1, smooth(failIn)));

    const passIn = seg(p, 0.84, 0.885);
    passStamp.visible = passIn > 0;
    passStamp.position.set(px + 0.95, py + 0.42, 0.05);
    passStamp.material.opacity = passIn * (exit > 0 ? 1 - seg(p, 0.94, 1) : 1);
    passStamp.scale.setScalar(lerp(1.7, 1, smooth(passIn)));

    // ---- gate state machine ----
    const scan1 = seg(p, 0.4, 0.5);
    const slam = seg(p, 0.5, 0.58);
    const scan2 = seg(p, 0.78, 0.84);
    const open = seg(p, 0.86, 0.96);
    const fm = field.material;
    if (open > 0) {
      fm.color.set(0x54c98a);
      fm.opacity = 0.16 * (1 - open * 0.75);
      field.scale.y = 1 - open * 0.9;
      setScore('pass');
    } else if (scan2 > 0) {
      fm.color.set(0xffcf6b);
      fm.opacity = 0.1 + scan2 * 0.06;
      field.scale.y = 1;
      setScore(scan2 >= 1 ? 'pass' : 'scoring');
    } else if (slam > 0) {
      fm.color.set(0xe0402f);
      fm.opacity = 0.24 - slam * 0.12;
      field.scale.y = 1;
      setScore('fail');
    } else if (scan1 > 0) {
      fm.color.set(0xffcf6b);
      fm.opacity = 0.08 + scan1 * 0.08;
      field.scale.y = 1;
      setScore('scoring');
    } else {
      fm.color.set(0x8899aa);
      fm.opacity = 0.07;
      field.scale.y = 1;
      setScore('idle');
    }
    if (p >= 0.84 && open === 0) setScore('pass');

    const sweep = scan1 > 0 && scan1 < 1 ? scan1 : scan2 > 0 && scan2 < 1 ? scan2 : -1;
    beam.material.opacity = sweep >= 0 ? 0.8 : 0;
    if (sweep >= 0) {
      beam.position.y = lerp(3.6, -1.5, sweep);
      beam.material.color.set(scan2 > 0 ? 0x54c98a : 0xffcf6b);
    }

    const slamK = slam > 0 && open === 0 ? 1 - slam : 0;
    pillarL.material.color.set(slamK > 0.02 ? 0xe0402f : open > 0 || p >= 0.84 ? 0x2e5c44 : 0x3c3c40);
    pillarR.material.color.copy(pillarL.material.color);

    poseCamera(p);
    renderer.render(scene, camera);
  }

  function size() {
    const w = mount.clientWidth || 1;
    const h = mount.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  size();
  window.addEventListener('resize', () => {
    size();
    render(lastP);
  });

  let lastP = 0;
  window.__grScene = {
    render(p) {
      lastP = p;
      render(p);
    },
  };
  render(0);
}

const pin = document.querySelector('#grScroll .gr-pin');
if (pin) {
  try {
    build(pin);
    pin.classList.add('gr-3d'); // only hide the DOM actors once the stage actually built
  } catch (err) {
    console.error('[gr-scene] build failed — DOM fallback active:', err);
    const stray = pin.querySelector('.gr-stage');
    if (stray) stray.remove();
    pin.classList.remove('gr-3d');
  }
}
