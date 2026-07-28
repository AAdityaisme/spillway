/*
 * The thread (v17.2) — a guiding light that escorts the scroll.
 * One request leaves the hero field and travels the page with you: a comet
 * in the left gutter whose tail streams with scroll velocity, glowing
 * brighter over dark tiles, sparking as it crosses each section boundary.
 * Fixed 2D canvas, pointer-events none, velocity-driven; disabled on
 * narrow viewports and under prefers-reduced-motion.
 */
(function () {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var mq = window.matchMedia('(min-width: 1100px)');

  var canvas = document.createElement('canvas');
  canvas.id = 'thread';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  var g = canvas.getContext('2d');
  if (!g) return;

  var BLUE = { r: 0, g: 102, b: 204 };
  var BRIGHT = { r: 96, g: 168, b: 255 };
  var X = 46; // the gutter lane
  var dpr = 1, W = 0, H = 0;

  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  size();
  window.addEventListener('resize', size);

  // sections whose boundaries make the comet spark; dark ones brighten it
  var sections = [];
  var darks = [];
  function mapSections() {
    sections = Array.prototype.slice.call(document.querySelectorAll('main > section')).map(function (el) {
      var r = el.getBoundingClientRect();
      return { top: r.top + window.scrollY, dark: /(^|\s)(dark|darker|gr-scroll)(\s|$)/.test(el.className) };
    });
    darks = sections.filter(function (s) { return s.dark; });
  }
  mapSections();
  window.addEventListener('resize', mapSections);
  setTimeout(mapSections, 1200); // after fonts/layout settle

  var lastY = window.scrollY;
  var vel = 0; // smoothed scroll velocity, px/frame
  var trail = []; // ring of {y, a} viewport-space points
  var sparks = [];
  var lastSection = -1;
  var t = 0;

  function sectionAt(docY) {
    var idx = -1;
    for (var i = 0; i < sections.length; i++) if (sections[i].top <= docY) idx = i;
    return idx;
  }

  function isDark(docY) {
    var idx = sectionAt(docY);
    return idx >= 0 && sections[idx].dark;
  }

  function frame() {
    t += 0.016;
    var sy = window.scrollY;
    vel += ((sy - lastY) - vel) * 0.12;
    lastY = sy;

    // comet head: rides at ~38vh, leaning into the scroll direction
    var lean = Math.max(-120, Math.min(120, vel * 2.2));
    var hy = H * 0.38 + Math.sin(t * 0.8) * 8 + lean;
    var docY = sy + hy;

    // don't compete with the hero's own scene — fade in after it
    var heroEnd = sections.length > 1 ? sections[1].top : 700;
    var born = Math.max(0, Math.min(1, (sy - heroEnd * 0.45) / (heroEnd * 0.35)));

    // spark when crossing a section boundary
    var si = sectionAt(docY);
    if (si !== lastSection && lastSection !== -1 && born > 0.5) {
      for (var k = 0; k < 7; k++) {
        sparks.push({
          x: X, y: hy,
          vx: (Math.random() - 0.2) * 2.2,
          vy: (Math.random() - 0.5) * 2.6,
          life: 1,
        });
      }
    }
    lastSection = si;

    // tail: stream opposite the travel direction, longer when moving faster
    trail.unshift({ y: hy, v: Math.abs(vel) });
    if (trail.length > 40) trail.pop();

    g.clearRect(0, 0, W, H);
    if (born <= 0.01) { requestAnimationFrame(frame); return; }

    var dark = isDark(docY);
    var c = dark ? BRIGHT : BLUE;
    var base = dark ? 0.95 : 0.75;

    // the rail: a full-height hairline the comet rides — traversed half glows warmer
    var railA = dark ? 0.16 : 0.1;
    g.strokeStyle = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + (railA * born).toFixed(3) + ')';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(X, 0); g.lineTo(X, hy - 18); g.stroke();
    g.strokeStyle = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + (railA * 0.45 * born).toFixed(3) + ')';
    g.beginPath(); g.moveTo(X, hy + 18); g.lineTo(X, H); g.stroke();

    // waypoints: one per section — passed ones lit, upcoming hollow
    for (var w = 1; w < sections.length; w++) {
      var wy = sections[w].top - sy;
      if (wy < -20 || wy > H + 20) continue;
      var passed = docY >= sections[w].top;
      var wc = sections[w].dark || dark ? BRIGHT : BLUE;
      if (passed) {
        g.fillStyle = 'rgba(' + wc.r + ',' + wc.g + ',' + wc.b + ',' + (0.85 * born).toFixed(3) + ')';
        g.beginPath(); g.arc(X, wy, 3, 0, Math.PI * 2); g.fill();
        var wg = g.createRadialGradient(X, wy, 0, X, wy, 10);
        wg.addColorStop(0, 'rgba(' + wc.r + ',' + wc.g + ',' + wc.b + ',' + (0.35 * born).toFixed(3) + ')');
        wg.addColorStop(1, 'rgba(' + wc.r + ',' + wc.g + ',' + wc.b + ',0)');
        g.fillStyle = wg;
        g.beginPath(); g.arc(X, wy, 10, 0, Math.PI * 2); g.fill();
      } else {
        g.strokeStyle = 'rgba(' + wc.r + ',' + wc.g + ',' + wc.b + ',' + (0.5 * born).toFixed(3) + ')';
        g.lineWidth = 1.2;
        g.beginPath(); g.arc(X, wy, 3, 0, Math.PI * 2); g.stroke();
      }
    }

    // tail — tapered dashes of light
    for (var i = 1; i < trail.length; i++) {
      var p0 = trail[i - 1], p1 = trail[i];
      var a = base * born * (1 - i / trail.length) * 0.5;
      if (a <= 0.01) continue;
      g.strokeStyle = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a.toFixed(3) + ')';
      g.lineWidth = Math.max(0.8, 3.4 * (1 - i / trail.length));
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(X, p0.y - (p0.y - p1.y) * 0.2);
      g.lineTo(X, p1.y);
      g.stroke();
    }

    // head — soft halo + core
    var halo = g.createRadialGradient(X, hy, 0, X, hy, 38);
    halo.addColorStop(0, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + (0.6 * born * (dark ? 1 : 0.7)).toFixed(3) + ')');
    halo.addColorStop(1, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',0)');
    g.fillStyle = halo;
    g.beginPath();
    g.arc(X, hy, 38, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,' + (0.98 * born).toFixed(3) + ')';
    g.beginPath();
    g.arc(X, hy, 2.6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + (0.9 * born).toFixed(3) + ')';
    g.beginPath();
    g.arc(X, hy, 4.6, 0, Math.PI * 2);
    g.fill();

    // sparks
    for (var j = sparks.length - 1; j >= 0; j--) {
      var s = sparks[j];
      s.x += s.vx; s.y += s.vy; s.vy += 0.02; s.life -= 0.03;
      if (s.life <= 0) { sparks.splice(j, 1); continue; }
      g.fillStyle = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + (s.life * 0.8).toFixed(3) + ')';
      g.fillRect(s.x, s.y, 2.4, 2.4);
    }

    requestAnimationFrame(frame);
  }

  function gate() {
    canvas.style.display = mq.matches ? 'block' : 'none';
  }
  gate();
  mq.addEventListener ? mq.addEventListener('change', gate) : mq.addListener(gate);

  requestAnimationFrame(frame);
})();
