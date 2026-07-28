/*
 * The spillway field, light register. A tilted disc of ~3,000 ink-blue
 * points streaming inward toward the gate ring; a few per second flare
 * amber and deflect. The whole disc is rolled to the same angle as the
 * page's diagonal band, so the hero literally rides the spillway.
 * Orbit rings + satellite nodes give the disc its instrument feel.
 * dpr ≤ 1.5, offscreen-paused, reduced-motion renders a single frame.
 */
import * as THREE from '../vendor/three.module.min.js';

const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const BAND_ANGLE = -0.21; // radians ≈ css rotate(12deg), screen-matched

class Field {
  constructor(mount, opts = {}) {
    this.mount = mount;
    this.thin = opts.thin || false;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    mount.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(46, 1, 0.1, 60);
    this.camera.position.set(0, 4.6, 10.5);
    this.camera.lookAt(0, -1.0, 0);

    this.group = new THREE.Group();
    this.group.rotation.z = BAND_ANGLE;
    this.group.position.y = this.thin ? -4.2 : -0.6;
    this.scene.add(this.group);

    const N = this.thin ? 1400 : 3000;
    this.N = N;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    this.meta = [];
    const BLUE = new THREE.Color(0x0066cc);
    const DEEP = new THREE.Color(0x0b3d7a);
    const SKY = new THREE.Color(0x2e9bff);
    const AMBER = new THREE.Color(0xd97706);
    this.BLUE = BLUE;
    this.DEEP = DEEP;
    this.SKY = SKY;
    this.AMBER = AMBER;

    for (let i = 0; i < N; i++) {
      const r = 2 + Math.pow(Math.random(), 0.65) * 9;
      const a = Math.random() * Math.PI * 2;
      this.meta.push({
        r,
        a,
        v: 0.12 + Math.random() * 0.3,
        flare: 0,
        y: (Math.random() - 0.5) * 0.5,
      });
      const roll = Math.random();
      const c = roll < 0.45 ? DEEP : roll < 0.85 ? BLUE : SKY;
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

    this.points = new THREE.Points(
      this.geo,
      new THREE.PointsMaterial({
        size: 0.09,
        map: Field.dot(),
        vertexColors: true,
        transparent: true,
        opacity: this.thin ? 0.5 : 0.78,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    this.group.add(this.points);

    // orbit rings: the instrument lines of the disc
    this.rings = [];
    for (const [r, o] of [
      [3.1, 0.3],
      [5.2, 0.22],
      [7.4, 0.15],
    ]) {
      const g = new THREE.BufferGeometry().setFromPoints(
        new THREE.EllipseCurve(0, 0, r, r).getPoints(128),
      );
      const ring = new THREE.LineLoop(
        g,
        new THREE.LineBasicMaterial({ color: 0x0066cc, transparent: true, opacity: this.thin ? o * 0.6 : o }),
      );
      ring.rotation.x = Math.PI / 2;
      this.group.add(ring);
      this.rings.push(ring);
    }

    // satellites: heavier nodes riding the rings
    this.sats = [];
    const satGeo = new THREE.BufferGeometry();
    const SN = this.thin ? 8 : 16;
    const satPos = new Float32Array(SN * 3);
    satGeo.setAttribute('position', new THREE.BufferAttribute(satPos, 3));
    for (let i = 0; i < SN; i++) {
      const ring = [3.1, 5.2, 7.4][i % 3];
      this.sats.push({ r: ring, a: Math.random() * Math.PI * 2, w: 0.05 + 0.05 / ring });
    }
    this.satPoints = new THREE.Points(
      satGeo,
      new THREE.PointsMaterial({
        size: 0.24,
        map: Field.dot(),
        color: 0x0b3d7a,
        transparent: true,
        opacity: this.thin ? 0.6 : 0.95,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    this.group.add(this.satPoints);

    // the core: a small dense heart inside the gate
    const core = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: Field.dot(),
        color: 0x0066cc,
        transparent: true,
        opacity: this.thin ? 0.18 : 0.22,
        depthWrite: false,
      }),
    );
    core.scale.setScalar(0.3);
    this.group.add(core);

    this.t = 0;
    this.step(0.5);

    this.size = this.size.bind(this);
    this.size();
    window.addEventListener('resize', this.size);

    if (reduce || this.thin) {
      // reduced motion, and the bookend: one composed still. The CTA
      // does not compete with a second live instrument.
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.px = 0;
    this.py = 0;
    if (!this.thin) {
      window.addEventListener(
        'pointermove',
        (e) => {
          this.px = (e.clientX / window.innerWidth - 0.5) * 2;
          this.py = (e.clientY / window.innerHeight - 0.5) * 2;
        },
        { passive: true },
      );
    }

    this.visible = true;
    this.raf = null;
    this.last = performance.now();
    new IntersectionObserver((es) => {
      this.visible = es[0].isIntersecting;
      if (this.visible && this.raf === null) this.loop(performance.now());
    }).observe(mount);
    this.loop(this.last);
  }

  static dot() {
    if (Field._dot) return Field._dot;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.7)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    Field._dot = tex;
    return tex;
  }

  size() {
    const w = this.mount.clientWidth || 1;
    const h = this.mount.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (reduce) this.renderer.render(this.scene, this.camera);
  }

  step(dt) {
    this.t += dt;
    const p = this.geo.attributes.position.array;
    const flaresAllowed = !this.thin;
    // first-visit beat: one scripted deflection ~2.2s in, so the
    // governance physics is seen, not left to chance
    if (flaresAllowed && !this.scripted && this.t > 2.2) {
      this.scripted = true;
      let flared = 0;
      for (let i = 0; i < this.N && flared < 6; i++) {
        if (this.meta[i].r > 1.2 && this.meta[i].r < 1.8) {
          this.meta[i].flare = 1.8;
          this.tint(i, this.AMBER);
          flared++;
        }
      }
    }
    for (let i = 0; i < this.N; i++) {
      const m = this.meta[i];
      m.r -= m.v * dt;
      m.a += dt * 0.02 + dt * (0.35 / Math.max(1.2, m.r));
      if (m.flare > 0) {
        m.flare -= dt;
        m.r += m.v * 4.8 * dt;
        if (m.flare <= 0)
          this.tint(i, Math.random() < 0.5 ? this.BLUE : this.DEEP);
      } else if (m.r < 1.15) {
        if (flaresAllowed && Math.random() < 0.14) {
          m.flare = 1.6;
          this.tint(i, this.AMBER);
        } else {
          m.r = 9.5 + Math.random() * 1.5;
          m.a = Math.random() * Math.PI * 2;
          m.y = (Math.random() - 0.5) * 0.5;
        }
      }
      p[i * 3] = Math.cos(m.a) * m.r;
      p[i * 3 + 1] = m.y * (m.r / 10) + Math.sin(this.t * 0.4 + i) * 0.02;
      p[i * 3 + 2] = Math.sin(m.a) * m.r;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;

    // satellites orbit; rings breathe against each other
    const sp = this.satPoints.geometry.attributes.position.array;
    for (let i = 0; i < this.sats.length; i++) {
      const s = this.sats[i];
      s.a += s.w * dt;
      sp[i * 3] = Math.cos(s.a) * s.r;
      sp[i * 3 + 1] = 0;
      sp[i * 3 + 2] = Math.sin(s.a) * s.r;
    }
    this.satPoints.geometry.attributes.position.needsUpdate = true;
    for (let i = 0; i < this.rings.length; i++) {
      this.rings[i].rotation.z = this.t * 0.008 * (i % 2 ? 1 : -1);
    }
  }

  tint(i, c) {
    const col = this.geo.attributes.color.array;
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }

  loop(now) {
    if (!this.visible) {
      this.raf = null;
      return;
    }
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.step(dt);
    // pointer parallax: the camera leans, never jumps
    this.camera.position.x += (this.px * 0.55 - this.camera.position.x) * Math.min(1, dt * 2.5);
    this.camera.position.y += (4.6 + this.py * 0.3 - this.camera.position.y) * Math.min(1, dt * 2.5);
    this.camera.lookAt(0, -1.0, 0);
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame((n) => this.loop(n));
  }
}

const bookend = document.getElementById('field2');
try {
  if (bookend) new Field(bookend, { thin: true });
} catch {
  /* no WebGL: the paper background and halo carry the bookend on its own */
}
