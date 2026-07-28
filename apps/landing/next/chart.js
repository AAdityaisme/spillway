/*
 * DEAD RECKONING — the hero as a navigator's chart.
 * One luminous spillway line (CatmullRom tube + two glow shells) rises
 * across the frame. Request traffic is plotted as GPU points: approved
 * points cross the line and fan out to the provider plates; blocked
 * points stall AT the line, flash red, and sink. Instanced ring
 * waymarks bead the line and light as you scroll. The line draws
 * itself on load (drawRange). Fog dissolves the far end into paper.
 * Zero lights, zero postprocessing, ~13 draw calls.
 */
import * as THREE from '../vendor/three.module.min.js';

const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const mount = document.getElementById('field');
const bookend = document.getElementById('field2');
try {
  if (mount) boot(mount, false);
  if (bookend) boot(bookend, true);
} catch (e) {
  document.body.classList.remove('launching');
  console.error('chart fallback:', e);
}

function boot(mount, still) {
  const mobile = window.innerWidth < 1000 || still;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, still ? 1.5 : 2));
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xf8f9fb, 10, 32);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 60);
  camera.position.set(0, 1.4, 13.5);
  camera.lookAt(0.2, 0.55, 0);

  /* ---- the chart floor: a graticule receding into fog ---- */
  const grid = new THREE.GridHelper(60, 40, 0xb9c4d6, 0xd4dbe8);
  grid.position.y = -3.2;
  grid.material.transparent = true;
  grid.material.opacity = still ? 0.25 : 0.35;
  grid.material.depthWrite = false;
  scene.add(grid);

  /* ---- the spillway ---- */
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-13, -1.6, -4.0),
    new THREE.Vector3(-7, -0.4, -1.5),
    new THREE.Vector3(-2, 0.3, 0.0),
    new THREE.Vector3(0, 0.55, 0.4),
    new THREE.Vector3(5, 1.3, 1.6),
    new THREE.Vector3(12, 2.6, 1.2),
  ]);
  const SEGS = 220;
  const tubeUniforms = {
    uBlockX: { value: 999 },
    uBlockFlash: { value: 0 },
    uBlockW: { value: 1.2 }, // world half-width of the hot zone
  };
  function tubeMaterial(color, opacity) {
    const m = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: Object.assign(
        {
          uColor: { value: new THREE.Color(color) },
          uOpacity: { value: opacity },
        },
        tubeUniforms,
      ),
      vertexShader:
        'varying vec3 vW; void main(){ vW = (modelMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader:
        'uniform vec3 uColor; uniform float uOpacity; uniform float uBlockX; uniform float uBlockFlash; uniform float uBlockW; varying vec3 vW;\n' +
        'void main(){ float hot = uBlockFlash * smoothstep(uBlockW, 0.0, abs(vW.x - uBlockX));\n' +
        '  vec3 c = mix(uColor, vec3(0.878, 0.251, 0.184), hot);\n' +
        '  gl_FragColor = vec4(c, uOpacity); }',
    });
    return m;
  }
  const line = new THREE.Mesh(new THREE.TubeGeometry(curve, SEGS, 0.05, 8, false), tubeMaterial(0x0066cc, 1));
  const glow1 = new THREE.Mesh(new THREE.TubeGeometry(curve, SEGS, 0.1, 8, false), tubeMaterial(0x2e9bff, 0.2));
  const glow2 = mobile
    ? null
    : new THREE.Mesh(new THREE.TubeGeometry(curve, SEGS, 0.2, 8, false), tubeMaterial(0x2e9bff, 0.09));
  const shadow = new THREE.Mesh(
    new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(curve.points.map((p) => p.clone().add(new THREE.Vector3(0, -0.4, 0)))),
      SEGS, 0.16, 8, false,
    ),
    new THREE.MeshBasicMaterial({ color: 0x0b1220, transparent: true, opacity: 0.05, depthWrite: false }),
  );
  scene.add(shadow, line, glow1);
  if (glow2) scene.add(glow2);
  // boot: the line charts itself
  const FULL = line.geometry.index.count;
  const tubes = [shadow, line, glow1, glow2].filter(Boolean);
  tubes.forEach((t) => t.geometry.setDrawRange(0, reduce || still ? FULL : 0));

  /* ---- waymarks: rings beading the line ---- */
  const WN = 14;
  const wayGeo = new THREE.RingGeometry(0.12, 0.16, 24);
  const wayMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.9 });
  const ways = new THREE.InstancedMesh(wayGeo, wayMat, WN);
  const wayColorOff = new THREE.Color(0xc3cad6);
  const wayColorOn = new THREE.Color(0x0066cc);
  const wayState = [];
  {
    const m = new THREE.Matrix4();
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < WN; i++) {
      const t = i / (WN - 1);
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), tan.clone().normalize());
      m.compose(p, q, new THREE.Vector3(1, 1, 1));
      ways.setMatrixAt(i, m);
      ways.setColorAt(i, wayColorOff);
      wayState.push({ t, lit: false, pulse: 0, p, q });
    }
    void up;
  }
  ways.instanceColor.needsUpdate = true;
  scene.add(ways);

  /* ---- ambient traffic: GPU points ---- */
  const N = mobile ? 32 : 60;
  const aStart = new Float32Array(N * 3);
  const aCross = new Float32Array(N * 3);
  const aExit = new Float32Array(N * 3);
  const aSeed = new Float32Array(N);
  const aBlocked = new Float32Array(N);
  const aTier = new Float32Array(N);
  const lanes = [-3, 0, 3];
  for (let i = 0; i < N; i++) {
    const lane = lanes[i % 3];
    aStart[i * 3] = -10 - Math.random() * 5;
    aStart[i * 3 + 1] = -2.6 + Math.random() * 1.6;
    aStart[i * 3 + 2] = lane + (Math.random() - 0.5) * 1.4;
    const ct = 0.5 + Math.random() * 0.12;
    const cp = curve.getPointAt(ct);
    aCross[i * 3] = cp.x;
    aCross[i * 3 + 1] = cp.y;
    aCross[i * 3 + 2] = cp.z;
    aExit[i * 3] = 3.0 + Math.random() * 1.2;
    aExit[i * 3 + 1] = 1.2 + Math.random() * 2.0;
    aExit[i * 3 + 2] = lane * 0.6 + (Math.random() - 0.5);
    aSeed[i] = Math.random();
    aBlocked[i] = i % 8 === 3 ? 1 : 0;
    aTier[i] = i % 3;
  }
  const ptsGeo = new THREE.BufferGeometry();
  ptsGeo.setAttribute('position', new THREE.BufferAttribute(aStart.slice(), 3));
  ptsGeo.setAttribute('aStart', new THREE.BufferAttribute(aStart, 3));
  ptsGeo.setAttribute('aCross', new THREE.BufferAttribute(aCross, 3));
  ptsGeo.setAttribute('aExit', new THREE.BufferAttribute(aExit, 3));
  ptsGeo.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
  ptsGeo.setAttribute('aBlocked', new THREE.BufferAttribute(aBlocked, 1));
  ptsGeo.setAttribute('aTier', new THREE.BufferAttribute(aTier, 1));
  const ptsUniforms = {
    uTime: { value: 0 },
    uPointer: { value: new THREE.Vector2(0, 0) },
    uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
  };
  const pts = new THREE.Points(
    ptsGeo,
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: ptsUniforms,
      vertexShader: `
        attribute vec3 aStart; attribute vec3 aCross; attribute vec3 aExit;
        attribute float aSeed; attribute float aBlocked; attribute float aTier;
        uniform float uTime; uniform vec2 uPointer; uniform float uPixelRatio;
        varying float vBlocked; varying float vPhase; varying float vTier;
        void main(){
          float t = fract(uTime * (0.055 + aSeed * 0.03) + aSeed);
          vec3 p;
          if (t < 0.5) {
            float k = smoothstep(0.0, 1.0, t / 0.5);
            float reach = mix(1.0, 0.94, aBlocked);
            p = mix(aStart, aCross, k * reach);
          } else if (aBlocked > 0.5) {
            float k = (t - 0.5) / 0.5;
            p = mix(aCross, aCross + vec3(0.0, -2.4, 0.0), k * k);
          } else {
            float k = (t - 0.5) / 0.5; k = k * k * (3.0 - 2.0 * k);
            p = mix(aCross, aExit, k);
          }
          p.xy += uPointer * 0.25;
          vBlocked = aBlocked; vPhase = t; vTier = aTier;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = (aTier < 0.5 ? 5.0 : 6.5) * uPixelRatio * (18.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vBlocked; varying float vPhase; varying float vTier;
        void main(){
          vec2 d = gl_PointCoord - vec2(0.5);
          if (dot(d, d) > 0.25) discard;
          vec3 blue = vTier < 0.5 ? vec3(0.043, 0.24, 0.478) : (vTier < 1.5 ? vec3(0.0, 0.4, 0.8) : vec3(0.18, 0.608, 1.0));
          vec3 red = vec3(0.878, 0.251, 0.184);
          vec3 c = (vBlocked > 0.5 && vPhase > 0.5) ? red : blue;
          float a = 0.75 * smoothstep(0.0, 0.08, vPhase) * (1.0 - smoothstep(0.86, 1.0, vPhase));
          gl_FragColor = vec4(c, a);
        }`,
    }),
  );
  scene.add(pts);

  /* ---- readable layer: canvas-textured request cards ---- */
  function plateTex(lines, opts) {
    const o = opts || {};
    const w = 340, h = 30 + lines.length * 34;
    const c = document.createElement('canvas');
    c.width = w * 2; c.height = h * 2;
    const g = c.getContext('2d');
    g.scale(2, 2);
    g.fillStyle = o.bg || 'rgba(255,255,255,0.97)';
    if (typeof g.roundRect === 'function') {
      g.beginPath(); g.roundRect(0, 0, w, h, 12); g.fill();
      g.strokeStyle = o.edge || 'rgba(11,18,32,0.12)';
      g.lineWidth = 1.5;
      g.beginPath(); g.roundRect(0.75, 0.75, w - 1.5, h - 1.5, 12); g.stroke();
    } else {
      g.fillRect(0, 0, w, h);
    }
    lines.forEach((ln, i) => {
      g.font = (ln.bold ? '600 ' : '400 ') + (ln.size || 15) + "px 'JetBrains Mono', monospace";
      g.fillStyle = ln.color || '#0b1220';
      g.fillText(ln.text, 18, 32 + i * 34);
    });
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return { tex, w, h };
  }
  function plate(lines, opts) {
    const { tex, w, h } = plateTex(lines, opts);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w / 150, h / 150),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    return mesh;
  }
  const CARDS = [
    { lines: [{ text: 'POST /v1/chat · summarize', bold: true }, { text: 'team growth · $0.0021', color: '#5a6478' }], blocked: false, phase: 0.0, ct: 0.5, zo: 0.6 },
    { lines: [{ text: 'POST /v1/chat · refactor hook', bold: true }, { text: 'team platform · $0.0164', color: '#5a6478' }], blocked: false, phase: 0.34, ct: 0.62, zo: -0.5 },
    { lines: [{ text: 'batch embed 2M docs', bold: true }, { text: 'budget exceeded · 402 · $0', color: '#b3423f' }], blocked: true, phase: 0.67, ct: 0.55, zo: 0.1 },
  ];
  const cardMeshes = mobile
    ? []
    : CARDS.map((cfg) => {
        const m = plate(cfg.lines, cfg.blocked ? { edge: 'rgba(224,64,47,0.4)' } : {});
        m.userData = cfg;
        cfg.cp = curve.getPointAt(cfg.ct).add(new THREE.Vector3(0, -0.25, cfg.zo));
        scene.add(m);
        return m;
      });

  /* ---- provider plates ---- */
  (mobile ? [] : ['gpt-4.1-mini', 'claude-haiku', 'gemini-flash']).forEach((name, i) => {
    const m = plate([{ text: name, bold: true, size: 17 }], { edge: 'rgba(0,102,204,0.22)' });
    m.position.set(2.55 + i * 0.08, 2.7 - i * 1.0, 0);
    m.userData.bob = Math.random() * Math.PI * 2;
    m.userData.provider = true;
    scene.add(m);
    cardMeshes.push(m);
  });

  /* ---- sizing ---- */
  function size() {
    const w = mount.clientWidth || 1;
    const h = mount.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  size();
  window.addEventListener('resize', size);

  /* ---- pointer ---- */
  let px = 0, py = 0;
  if (!reduce) {
    window.addEventListener(
      'pointermove',
      (e) => {
        px = (e.clientX / window.innerWidth - 0.5) * 2;
        py = -(e.clientY / window.innerHeight - 0.5) * 2;
      },
      { passive: true },
    );
  }

  /* ---- scroll progress over the hero ---- */
  let scrollP = 0;
  function onScroll() {
    const r = mount.getBoundingClientRect();
    scrollP = Math.min(1, Math.max(0, -r.top / Math.max(1, r.height - window.innerHeight * 0.4)));
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---- reduced motion: compose one frame and stop ---- */
  if (reduce) {
    stepCards(2.5);
    litWaymarks(0.5, true);
    renderer.render(scene, camera);
    document.body.classList.remove('launching');
    window.dispatchEvent(new Event('spillway:launched'));
    return;
  }

  /* ---- bookend: the line charts itself once, on arrival ---- */
  if (still) {
    stepCards(2.5);
    litWaymarks(0.5, true);
    tubes.forEach((t) => t.geometry.setDrawRange(0, 0));
    let drawn = false;
    new IntersectionObserver((es, o) => {
      if (!es[0].isIntersecting || drawn) return;
      drawn = true;
      o.disconnect();
      const t0 = performance.now();
      (function draw(now) {
        const p = Math.min(1, (now - t0) / 1400);
        const e = p * p * (3 - 2 * p);
        tubes.forEach((t) => t.geometry.setDrawRange(0, Math.floor(FULL * e)));
        renderer.render(scene, camera);
        if (p < 1) requestAnimationFrame(draw);
      })(t0);
    }, { threshold: 0.3 }).observe(mount);
    renderer.render(scene, camera);
    return;
  }

  /* ---- loop ---- */
  let visible = true;
  let raf = null;
  new IntersectionObserver((es) => {
    visible = es[0].isIntersecting;
    if (visible && raf === null) loop(performance.now());
  }).observe(mount);

  let last = performance.now();
  let T = 0;
  let booted = 0;

  /* ---- the interception ----
     One request, one gate, one block. The film is the page's own camera
     leaning toward the gate: the strike is the FIRST beat, and the ending
     pose IS the hero, so the film becomes the page with no cut. */
  const INK = new THREE.Color(0x0a0e1a);
  const PAPER = new THREE.Color(0xf8f9fb);
  // 0.55 = the blocked card's crossing point: the gate, the strike flash,
  // and the card's death all share one spot on the line
  const crossZone = curve.getPointAt(0.55);

  /* the gate: a hairline cap post standing on the line, live in the page */
  let gatePost = null;
  if (!mobile) {
    const gate = new THREE.Group();
    const post = new THREE.Mesh(
      new THREE.PlaneGeometry(0.035, 3.0),
      new THREE.MeshBasicMaterial({
        color: 0x0066cc,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
      }),
    );
    post.position.y = 0.55;
    gate.add(post);
    gatePost = post;
    const cap = plate([{ text: 'org cap · $10k/day', size: 13 }], {
      edge: 'rgba(0,102,204,0.3)',
    });
    cap.scale.setScalar(0.6);
    cap.position.y = 2.25;
    gate.add(cap);
    gate.position.copy(crossZone);
    scene.add(gate);
  }

  const LAUNCH_LEN = 2.8;
  let launch = -1; // -1 = no film; 0.. = film time
  let hitA = false; // the strike, fires once
  let filmCard = null; // the one request the film follows

  const capText = document.getElementById('filmCapText');
  const capWrap = document.getElementById('filmCap');
  const CAPTIONS = [
    'every request crosses one line',
    '',
    'budget exceeded · 402 · blocked',
    '',
  ];
  let capShot = -1;
  function caption(shot) {
    if (shot === capShot || !capText) return;
    capShot = shot;
    capText.textContent = CAPTIONS[shot];
    capWrap.classList.toggle('hit', shot === 2);
    if (shot === 3) capWrap.classList.add('dim');
  }

  const skip = () => {
    if (launch >= 0) launch = LAUNCH_LEN;
  };
  function startFilm() {
    document.body.classList.add('launching');
    window.scrollTo(0, 0);
    scene.background = INK.clone();
    scene.fog.color.set(INK);
    // the film opens on the finished line at full luminance; the
    // self-charting boot belongs to the page, not the film
    booted = 1;
    tubes.forEach((t) => t.geometry.setDrawRange(0, FULL));
    // one request in flight, timed to strike the gate at t=1.15. It flies
    // with an in-flight texture; the verdict is stamped at the strike.
    cardMeshes.forEach((m) => {
      if (m.userData.provider) return;
      if (m.userData.phase0 === undefined) m.userData.phase0 = m.userData.phase;
      m.visible = false;
    });
    filmCard = cardMeshes.find((m) => m.userData.blocked);
    if (filmCard) {
      if (!filmCard.userData.verdictMap) filmCard.userData.verdictMap = filmCard.material.map;
      if (!filmCard.userData.flightMap)
        filmCard.userData.flightMap = plateTex(
          [
            { text: 'batch embed 2M docs', bold: true },
            { text: 'team data · $31.90 est', color: '#5a6478' },
          ],
          {},
        ).tex;
      filmCard.material.map = filmCard.userData.flightMap;
      filmCard.userData.phase = 0.534 - 1.15 * 0.042;
      filmCard.visible = true;
    }
    hitA = false;
    launch = 0;
    capShot = -1;
    if (capWrap) capWrap.classList.remove('dim', 'hit');
    try {
      sessionStorage.setItem('mFilmSeen', '1');
    } catch {
      /* privacy mode: it just replays next visit */
    }
    size();
    window.addEventListener('wheel', skip, { once: true, passive: true });
    window.addEventListener('pointerdown', skip, { once: true });
    window.addEventListener('keydown', skip, { once: true });
  }

  /* the generated film: when ./launch.mp4 plays, it owns the opener and
     the live interception becomes the fallback. ?open=live forces live. */
  function startVideoFilm() {
    const v = document.getElementById('launchVideo');
    if (!v) return startFilm();
    let done = false;
    let fell = false;
    const fallback = () => {
      if (done || fell) return;
      fell = true;
      v.pause();
      document.body.classList.remove('video-mode');
      startFilm();
    };
    const finish = () => {
      if (done || fell) return;
      done = true;
      document.body.classList.add('exposing'); // the white pop
      setTimeout(() => {
        document.body.classList.remove('launching', 'video-mode', 'exposing');
        v.pause();
        window.dispatchEvent(new Event('spillway:launched'));
      }, 220);
    };
    document.body.classList.add('launching', 'video-mode');
    window.scrollTo(0, 0);
    try {
      sessionStorage.setItem('mFilmSeen', '1');
    } catch {
      /* fine */
    }
    capShot = -1;
    if (capWrap) capWrap.classList.remove('dim', 'hit');
    caption(0);
    v.src = './launch.mp4';
    v.currentTime = 0;
    v.addEventListener('ended', finish);
    v.addEventListener('error', fallback, { once: true });
    v.addEventListener('timeupdate', () => {
      if (!v.duration) return;
      if (v.currentTime > v.duration - 0.5) caption(3);
      else if (v.currentTime > 3.0) caption(2); // the strike shot opens
    });
    const guard = setTimeout(() => {
      if (v.readyState < 2) fallback(); // never started: go live
    }, 1600);
    v.play().then(() => clearTimeout(guard)).catch(fallback);
    window.addEventListener('wheel', finish, { once: true, passive: true });
    window.addEventListener('pointerdown', finish, { once: true });
    window.addEventListener('keydown', finish, { once: true });
  }

  // first visit only, desktop only, foreground only, and never against a
  // visitor who already scrolled before this module loaded
  let filmEligible = !mobile && !document.hidden && !window.__mSkip;
  try {
    filmEligible = filmEligible && !sessionStorage.getItem('mFilmSeen');
  } catch {
    /* privacy mode: play it, we just can't remember */
  }
  const liveOpen = new URLSearchParams(location.search).get('open') === 'live';
  if (filmEligible) {
    if (liveOpen) startFilm();
    else startVideoFilm();
  } else {
    document.body.classList.remove('launching');
    window.dispatchEvent(new Event('spillway:launched'));
  }
  const replayBtn = document.getElementById('replayFilm');
  if (replayBtn && !mobile)
    replayBtn.addEventListener('click', () => (liveOpen ? startFilm() : startVideoFilm()));

  function launchCam(t) {
    caption(t < 1.13 ? 0 : t < 2.35 ? 2 : 3);
    // one grounded shot: lean toward the gate for the strike, then ease
    // exactly home as the ink floods, so the last frame IS the hero
    const s = (x) => x * x * (3 - 2 * x);
    const push = t < 0.45 ? s(t / 0.45) : t < 2.0 ? 1 : 1 - s(Math.min(1, (t - 2.0) / 0.8));
    camera.position.set(
      crossZone.x * 0.35 * push,
      1.4 + (crossZone.y + 0.75 - 1.4) * push,
      13.5 + (9.8 - 13.5) * push,
    );
    camera.lookAt(
      0.2 + (crossZone.x - 0.2) * push,
      0.55 + (crossZone.y - 0.55) * push,
      crossZone.z * push,
    );
    if (!hitA && t > 1.13) {
      hitA = true;
      tubeUniforms.uBlockX.value = crossZone.x;
      tubeUniforms.uBlockFlash.value = 1;
      // at film-camera distance the page's tight hot zone reads as a
      // smudge: the strike goes frame-wide so the whole line takes it
      tubeUniforms.uBlockW.value = 9;
      // the gate itself takes the hit
      if (gatePost) {
        gatePost.material.color.set(0xe0402f);
        gatePost.material.opacity = 0.85;
      }
      // the verdict lands with the strike
      if (filmCard) filmCard.material.map = filmCard.userData.verdictMap;
    }
    // the develop is a pop, not a fade: ink holds to the end, then floods
    // to paper in the last ~0.12s (fog turns any slower lerp to gray mud)
    const k = Math.max(0, (t - 2.0) / 0.8);
    const p = Math.max(0, (k - 0.85) / 0.15);
    const d = p * p;
    scene.background.lerpColors(INK, PAPER, d);
    scene.fog.color.lerpColors(INK, PAPER, d);
  }
  const tmpM = new THREE.Matrix4();
  const tmpS = new THREE.Vector3();

  function stepCards(t) {
    cardMeshes.forEach((m) => {
      if (m.userData.provider) {
        m.position.y += Math.sin(t * 0.8 + m.userData.bob) * 0.0016;
        m.lookAt(camera.position);
        return;
      }
      const cfg = m.userData;
      const crossPoint = cfg.cp;
      const ph = (t * 0.042 + cfg.phase) % 1;
      if (ph < 0.55) {
        const k = ph / 0.55;
        const e = k * k * (3 - 2 * k);
        const reach = cfg.blocked ? 0.985 : 1;
        m.position.set(
          0.3 * (1 - e) + crossPoint.x * e * reach,
          -3.6 + (crossPoint.y + 3.6) * e,
          -0.8 + (crossPoint.z + 0.8) * e,
        );
        m.material.opacity = Math.min(1, k * 4) * (cfg.blocked && k > 0.96 ? 1 : 1);
        if (cfg.blocked && k > 0.97) {
          tubeUniforms.uBlockX.value = crossPoint.x;
          tubeUniforms.uBlockFlash.value = 1;
        }
      } else if (cfg.blocked) {
        const k = (ph - 0.55) / 0.45;
        m.position.set(crossPoint.x - 0.15, crossPoint.y - k * k * 2.6, crossPoint.z);
        m.material.opacity = 1 - k;
      } else {
        const k = (ph - 0.55) / 0.45;
        const e = k * k * (3 - 2 * k);
        m.position.set(crossPoint.x + (3.1 - crossPoint.x) * e, crossPoint.y + 1.4 * e, crossPoint.z + 0.8 * e);
        m.material.opacity = 1 - Math.max(0, (k - 0.75) * 4);
      }
      m.lookAt(camera.position);
    });
  }

  function litWaymarks(p, instant) {
    wayState.forEach((w, i) => {
      const should = w.t <= 0.2 + p * 0.8;
      if (should && !w.lit) {
        w.lit = true;
        w.pulse = instant ? 0 : 1;
        ways.setColorAt(i, wayColorOn);
        ways.instanceColor.needsUpdate = true;
      }
      if (w.pulse > 0) {
        w.pulse = Math.max(0, w.pulse - 0.04);
        const s = 1 + Math.sin((1 - w.pulse) * Math.PI) * 0.25;
        tmpS.set(s, s, s);
        tmpM.compose(w.p, w.q, tmpS);
        ways.setMatrixAt(i, tmpM);
        ways.instanceMatrix.needsUpdate = true;
      }
    });
  }

  function loop(now) {
    if (!visible) {
      raf = null;
      return;
    }
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
    last = now;
    T += dt;

    // boot: the spillway charts itself
    if (booted < 1) {
      booted = Math.min(1, booted + dt / (launch >= 0 && launch < LAUNCH_LEN ? 0.7 : 1.4));
      const e = booted * booted * (3 - 2 * booted);
      tubes.forEach((t) => t.geometry.setDrawRange(0, Math.floor(FULL * e)));
    }

    // the launch film owns the camera until it ends
    if (launch >= 0 && launch < LAUNCH_LEN) {
      launch += dt;
      launchCam(Math.min(launch, LAUNCH_LEN - 0.001));
      if (launch >= LAUNCH_LEN) {
        scene.background = null;
        scene.fog.color.set(0xf8f9fb);
        document.body.classList.remove('launching');
        cardMeshes.forEach((m) => {
          if (m.userData.provider) return;
          if (m.userData.phase0 !== undefined) m.userData.phase = m.userData.phase0;
          m.visible = true;
        });
        if (filmCard && filmCard.userData.verdictMap)
          filmCard.material.map = filmCard.userData.verdictMap;
        tubeUniforms.uBlockW.value = 1.2; // page blocks keep the tight zone
        if (gatePost) {
          gatePost.material.color.set(0x0066cc);
          gatePost.material.opacity = 0.32;
        }
        size();
        camera.position.set(0, 1.4, 13.5);
        camera.lookAt(0.2, 0.55, 0);
        window.dispatchEvent(new Event('spillway:launched'));
      } else {
        ptsUniforms.uTime.value = T;
        // the strike holds at full red, then cools fast enough that the
        // off-palette magenta window is a blink, not a beat
        const hold = launch > 1.13 && launch < 1.9;
        tubeUniforms.uBlockFlash.value = hold
          ? Math.max(tubeUniforms.uBlockFlash.value, 0.92)
          : Math.max(0, tubeUniforms.uBlockFlash.value - dt * 4.5);
        if (gatePost && !hold && hitA) {
          gatePost.material.color.lerp(new THREE.Color(0x0066cc), Math.min(1, dt * 3));
          gatePost.material.opacity += (0.32 - gatePost.material.opacity) * Math.min(1, dt * 3);
        }
        stepCards(T);
        renderer.render(scene, camera);
        raf = requestAnimationFrame(loop);
        return;
      }
    }

    ptsUniforms.uTime.value = T;
    ptsUniforms.uPointer.value.set(px * 0.4, py * 0.25);
    tubeUniforms.uBlockFlash.value = Math.max(0, tubeUniforms.uBlockFlash.value - dt * 2.2);

    stepCards(T);
    litWaymarks(scrollP, false);

    // camera: pointer parallax + scroll dolly along the line
    camera.position.x += (px * 0.55 - 1.5 * scrollP - camera.position.x) * Math.min(1, dt * 2.5);
    camera.position.y += (1.4 + py * 0.3 - camera.position.y) * Math.min(1, dt * 2.5);
    camera.position.z += (13.5 - 2.0 * scrollP - camera.position.z) * Math.min(1, dt * 2.5);
    camera.lookAt(0.2, 0.55, 0);

    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }
  loop(last);
}
