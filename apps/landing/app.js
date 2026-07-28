/*
 * Homepage v4 behaviors. Vanilla, three signature moments only:
 * the field (field.js), the spillway band drift, the budget-block.
 * Everything else is a fire-once reveal. All motion ships a
 * reduced-motion twin.
 */
(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- nav scrolled state + spillway band drift ---------- */
  var nav = document.getElementById('nav');
  var plane = document.getElementById('plane');
  var WAYS = ['top', 'console', 'setup', 'how', 'actBudgets', 'actApprovals', 'actAnomaly', 'actRouting'];
  var wayEls = WAYS.map(function (id) {
    return document.getElementById(id);
  });
  var wayTokens = [].slice.call(document.querySelectorAll('.waymarks b'));
  var activeWay = '';
  function onScroll() {
    nav.classList.toggle('scrolled', window.scrollY > 8);
    if (plane && !reduce) {
      // the band counter-drifts as you descend: crossing the line
      plane.style.setProperty('--drift', (window.scrollY * -0.16).toFixed(1) + 'px');
      var prog = window.scrollY / Math.max(1, document.body.scrollHeight - window.innerHeight);
      plane.style.setProperty('--prog', prog.toFixed(4));
    }
    if (!reduce && wayTokens.length) {
      // the waymark whose section is crossing mid-viewport lights up:
      // the band reads the page back to you as you descend
      var mid = window.innerHeight * 0.5;
      var current = '';
      for (var i = 0; i < wayEls.length; i++) {
        var el = wayEls[i];
        if (!el) continue;
        var r = el.getBoundingClientRect();
        if (r.top <= mid && r.bottom >= mid) {
          current = WAYS[i];
          break;
        }
      }
      if (current !== activeWay) {
        activeWay = current;
        wayTokens.forEach(function (t) {
          t.classList.toggle('on', t.getAttribute('data-way') === current);
        });
      }
    }
  }
  var ticking = false;
  window.addEventListener(
    'scroll',
    function () {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(function () {
          onScroll();
          ticking = false;
        });
      }
    },
    { passive: true },
  );
  onScroll();

  /* ---------- hero headline: words rise along the diagonal ---------- */
  var heroH1 = document.querySelector('.hero .h1');
  if (heroH1 && !reduce) {
    var walker = document.createTreeWalker(heroH1, NodeFilter.SHOW_TEXT);
    var textNodes = [];
    while (walker.nextNode()) {
      if (walker.currentNode.parentElement.closest('.tip')) continue;
      if (walker.currentNode.textContent.trim()) textNodes.push(walker.currentNode);
    }
    var wordIndex = 0;
    textNodes.forEach(function (node) {
      var frag = document.createDocumentFragment();
      node.textContent.split(/(\s+)/).forEach(function (piece) {
        if (!piece.trim()) {
          frag.appendChild(document.createTextNode(piece));
          return;
        }
        var clip = document.createElement('span');
        clip.className = 'w-clip';
        var word = document.createElement('span');
        word.className = 'w';
        word.style.transitionDelay = 120 + wordIndex * 70 + 'ms';
        word.textContent = piece;
        clip.appendChild(word);
        frag.appendChild(clip);
        wordIndex++;
      });
      node.parentNode.replaceChild(frag, node);
    });
    var assembled = false;
    function assemble() {
      if (assembled) return;
      assembled = true;
      heroH1.classList.add('assembled');
    }
    window.addEventListener('spillway:launched', assemble);
    // The mobile/no-film paths dispatch spillway:launched before this listener attaches
    // (chart.js runs first) — if no launch is in progress now, don't hold the headline.
    if (!document.body.classList.contains('launching')) requestAnimationFrame(assemble);
    setTimeout(assemble, 5000); // last-resort fallback
  }

  /* ---------- reveals: fire once ---------- */
  var io = new IntersectionObserver(
    function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      });
    },
    { threshold: 0.16, rootMargin: '0px 0px -6%' },
  );
  [].forEach.call(document.querySelectorAll('.rv'), function (el) {
    io.observe(el);
  });

  /* ---------- widget triggers ---------- */
  var wio = new IntersectionObserver(
    function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('in-view');
          wio.unobserve(e.target);
        }
      });
    },
    { threshold: 0.45 },
  );
  ['actBudgets'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) wio.observe(el);
  });

  /* ---------- approval widget: pending → approved, once, on view ---------- */
  var ap = document.getElementById('actApprovals');
  if (ap) {
    new IntersectionObserver(function (es, o) {
      if (!es[0].isIntersecting) return;
      o.disconnect();
      var state = document.getElementById('apState');
      var chip = document.getElementById('apApprove');
      if (reduce) {
        state.textContent = 'approved · resumed in 6 min';
        state.classList.add('ok');
        return;
      }
      setTimeout(function () {
        chip.style.background = 'rgba(15,157,110,0.1)';
        setTimeout(function () {
          state.textContent = 'approved · budget raised · stream resumed';
          state.classList.add('ok');
        }, 500);
      }, 1600);
    }, { threshold: 0.5 }).observe(ap);
  }

  /* ---------- live route ledger: rows keep arriving while in view ---------- */
  var ledger = document.getElementById('ledger');
  if (ledger && !reduce) {
    var FEED = [
      ['extract invoice fields', 'haiku', '−91%'],
      ['draft churn email', '4.1-mini', '−68%'],
      ['label training batch', 'flash-lite', '−89%'],
      ['review legal clause', 'sonnet', '−41%'],
      ['triage error report', 'haiku', '−93%'],
      ['translate release notes', 'flash-lite', '−86%'],
      ['score sales call', '4.1-mini', '−74%'],
      ['audit access request', 'sonnet', '−38%'],
    ];
    var fi = 0;
    var armed = false;
    function pushRow() {
      var f = FEED[fi % FEED.length];
      fi++;
      var row = document.createElement('div');
      row.className = 'row fresh';
      row.innerHTML =
        '<span class="task"></span><span class="model"></span><span class="delta num"></span>';
      row.children[0].textContent = f[0];
      row.children[1].textContent = f[1];
      row.children[2].textContent = f[2];
      ledger.insertBefore(row, ledger.firstChild);
      while (ledger.children.length > 4) ledger.removeChild(ledger.lastChild);
    }
    new IntersectionObserver(function (es) {
      if (es[0].isIntersecting && !armed) {
        armed = true;
        for (var i = 0; i < 4; i++) setTimeout(pushRow, 300 + i * 350);
      } else if (!es[0].isIntersecting) {
        armed = false;
      }
    }, { threshold: 0.4 }).observe(ledger);
  }

  /* ---------- stat band: odometer digit strips ---------- */
  function countUp(el) {
    var target = parseInt(el.getAttribute('data-count'), 10);
    var prefix = el.getAttribute('data-prefix') || '';
    var suffix = el.getAttribute('data-suffix') || '';
    var final = target.toLocaleString('en-US');
    if (reduce) {
      el.innerHTML = prefix + final + '<span class="u">' + suffix + '</span>';
      return;
    }
    // build one rolling strip per digit; separators stay static
    el.textContent = '';
    if (prefix) el.appendChild(document.createTextNode(prefix));
    var strips = [];
    final.split('').forEach(function (ch, i) {
      if (ch < '0' || ch > '9') {
        el.appendChild(document.createTextNode(ch));
        return;
      }
      var slot = document.createElement('span');
      slot.className = 'odo';
      var strip = document.createElement('span');
      strip.className = 'odo-strip';
      strip.style.transitionDelay = i * 70 + 'ms';
      for (var d = 0; d <= 9; d++) {
        var dd = document.createElement('span');
        dd.textContent = d;
        strip.appendChild(dd);
      }
      slot.appendChild(strip);
      el.appendChild(slot);
      strips.push({ strip: strip, digit: +ch });
    });
    var suf = document.createElement('span');
    suf.className = 'u';
    suf.textContent = suffix;
    el.appendChild(suf);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        strips.forEach(function (s) {
          s.strip.style.transform = 'translateY(' + -s.digit + 'em)';
        });
      });
    });
  }
  var sio = new IntersectionObserver(
    function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting) {
          countUp(e.target);
          sio.unobserve(e.target);
        }
      });
    },
    { threshold: 0.6 },
  );
  [].forEach.call(document.querySelectorAll('[data-count]'), function (el) {
    sio.observe(el);
  });

  /* ---------- console: typed request resolving to a decision ---------- */
  var typed = document.getElementById('typed');
  if (typed) {
    var SCENES = [
      {
        prompt: 'Regenerate embeddings for the entire 2M-document corpus.',
        tiers: [0.02, 0.18, 0.8],
        model: 'blocked by policy',
        cost: 'key · batch-embed',
        lat: 'daily cap $1k',
        save: 'would exceed by $312',
        verdict: '✕ blocked · 402 budget_exceeded · $0 spent',
        blocked: true,
      },
      {
        prompt: "What's the capital of Portugal?",
        tiers: [0.94, 0.05, 0.01],
        model: 'claude-haiku',
        cost: '$0.80 / M tok',
        lat: '1.3 s',
        save: '−92% vs frontier',
        verdict: '✓ allowed · routed · logged',
        blocked: false,
      },
      {
        prompt: 'Refactor this React hook to support cancellation with TypeScript generics.',
        tiers: [0.08, 0.69, 0.23],
        model: 'gpt-4.1-mini',
        cost: '$1.60 / M tok',
        lat: '2.1 s',
        save: '−72% vs frontier',
        verdict: '✓ allowed · routed · logged',
        blocked: false,
      },

    ];
    var caret = document.getElementById('caret');
    var tokv = document.getElementById('tokv');
    var tC = document.getElementById('tC'),
      tM = document.getElementById('tM'),
      tP = document.getElementById('tP');
    var lC = document.getElementById('lC'),
      lM = document.getElementById('lM'),
      lP = document.getElementById('lP');
    var dec = document.getElementById('decision');
    var rsltBar = document.getElementById('rsltBar');
    var dModel = document.getElementById('dModel'),
      dCost = document.getElementById('dCost'),
      dLat = document.getElementById('dLat'),
      dSave = document.getElementById('dSave'),
      dVerdict = document.getElementById('dVerdict');

    function setScene(s, instant) {
      tC.style.flexGrow = s.tiers[0];
      tM.style.flexGrow = s.tiers[1];
      tP.style.flexGrow = s.tiers[2];
      lC.textContent = 'cheap · ' + Math.round(s.tiers[0] * 100) + '%';
      lM.textContent = 'mid · ' + Math.round(s.tiers[1] * 100) + '%';
      lP.textContent = 'premium · ' + Math.round(s.tiers[2] * 100) + '%';
      dModel.textContent = s.model;
      dCost.textContent = s.cost;
      dLat.textContent = s.lat;
      dSave.textContent = s.save;
      dSave.style.color = s.blocked ? 'var(--amber)' : '';
      dVerdict.textContent = s.verdict;
      dec.classList.toggle('blocked', s.blocked);
      if (rsltBar) {
        rsltBar.textContent = s.blocked
          ? 'BLOCKED → 402 budget_exceeded · $0 spent · policy snapshot logged ✓'
          : 'ROUTED → ' + s.model + ' · ' + s.cost + ' · ' + s.lat + ' · ' + s.save + ' · logged ✓';
        rsltBar.style.color = s.blocked ? 'var(--amber)' : '';
      }
      if (instant) {
        typed.textContent = s.prompt;
        tokv.textContent = Math.round(s.prompt.length * 0.34);
      }
    }

    /* ---- type-your-own: local classifier over the same setScene ---- */
    var interactive = false;
    var tryBtn = document.getElementById('tryOwn');
    function classify(q) {
      var t = q.toLowerCase();
      var toks = Math.max(1, Math.round(q.length * 0.34));
      if (/(entire|all\s|every|2m|corpus|regenerate|backfill|bulk|batch)/.test(t) && /(embed|document|corpus|dataset|records)/.test(t)) {
        return {
          prompt: q, tiers: [0.02, 0.18, 0.8], model: 'blocked by policy',
          cost: 'key · batch-embed', lat: 'daily cap $1k',
          save: 'would exceed daily cap', verdict: '✕ blocked · 402 budget_exceeded · $0 spent', blocked: true,
        };
      }
      var hard = /(refactor|typescript|architect|debug|prove|derive|optimi[sz]e|design\s|legal|contract|audit)/.test(t);
      var easy = /(what|who|when|capital|translate|classify|label|extract|summar|list|define)/.test(t);
      var tier = hard || q.length > 140 ? (q.length > 260 ? 'prem' : 'mid') : easy || q.length < 70 ? 'cheap' : 'mid';
      if (tier === 'cheap')
        return { prompt: q, tiers: [0.9, 0.08, 0.02], model: 'claude-haiku', cost: '$0.80 / M tok', lat: '1.3 s', save: '−92% vs frontier', verdict: '✓ allowed · routed · logged', blocked: false };
      if (tier === 'mid')
        return { prompt: q, tiers: [0.1, 0.72, 0.18], model: 'gpt-4.1-mini', cost: '$1.60 / M tok', lat: '2.1 s', save: '−72% vs frontier', verdict: '✓ allowed · routed · logged', blocked: false };
      return { prompt: q, tiers: [0.03, 0.22, 0.75], model: 'claude-sonnet', cost: '$6.00 / M tok', lat: '3.4 s', save: '−38% vs frontier', verdict: '✓ allowed · routed · logged', blocked: false };
    }
    var promptBox = document.querySelector('.cprompt');
    function enterInteractive() {
      interactive = true;
      caret.style.display = 'none';
      typed.textContent = '';
      promptBox.setAttribute('contenteditable', 'true');
      promptBox.setAttribute('role', 'textbox');
      promptBox.setAttribute('aria-label', 'Type a request and press Enter to see it scored and routed');
      promptBox.focus();
      tryBtn.textContent = '▸ press enter to route it';
      dVerdict.textContent = 'awaiting your request';
      if (rsltBar) { rsltBar.textContent = 'listening ···'; rsltBar.style.color = ''; }
    }
    if (tryBtn) {
      tryBtn.addEventListener('click', function () {
        if (!interactive) enterInteractive();
      });
      promptBox.addEventListener('keydown', function (e) {
        if (!interactive) return;
        if (e.key === 'Escape') {
          interactive = false;
          promptBox.removeAttribute('contenteditable');
          promptBox.removeAttribute('role');
          promptBox.blur();
          typed.textContent = '';
          promptBox.childNodes.forEach(function (n) {
            if (n.nodeType === 3) n.remove();
          });
          tryBtn.textContent = '▸ type your own request';
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          var q = this.textContent.trim();
          if (!q) return;
          setScene(classify(q), false);
          tokv.textContent = Math.max(1, Math.round(q.length * 0.34));
          tryBtn.textContent = '▸ try another';
        }
      });
      promptBox.addEventListener('input', function () {
        if (interactive) tokv.textContent = Math.max(0, Math.round(this.textContent.length * 0.34));
      });
    }

    if (reduce) {
      caret.style.display = 'none';
      setScene(SCENES[0], true);
    } else {
      var visible = false,
        running = false;
      new IntersectionObserver(function (es) {
        visible = es[0].isIntersecting;
        if (visible && !running) run();
      }, { threshold: 0.35 }).observe(dec);

      var idx = 0;
      function sleep(ms) {
        return new Promise(function (r) {
          setTimeout(r, ms);
        });
      }
      async function run() {
        running = true;
        while (visible) {
          if (interactive) {
            await sleep(600);
            continue;
          }
          var s = SCENES[idx % SCENES.length];
          idx++;
          // reset
          typed.textContent = '';
          tokv.textContent = '0';
          caret.style.display = 'inline-block';
          dModel.textContent = '···';
          dCost.textContent = '···';
          dLat.textContent = '···';
          dSave.textContent = '···';
          dVerdict.textContent = 'scoring…';
          dec.classList.remove('blocked');
          if (rsltBar) {
            rsltBar.textContent = 'metering request ···';
            rsltBar.style.color = '';
          }
          tC.style.flexGrow = 0;
          tM.style.flexGrow = 0;
          tP.style.flexGrow = 0;
          lC.textContent = 'cheap';
          lM.textContent = 'mid';
          lP.textContent = 'premium';
          await sleep(500);
          // type
          for (var i = 0; i <= s.prompt.length && visible && !interactive; i++) {
            typed.textContent = s.prompt.slice(0, i);
            tokv.textContent = Math.max(0, Math.round(i * 0.34));
            await sleep(16 + Math.random() * 26);
          }
          if (interactive) continue;
          caret.style.display = 'none';
          await sleep(420);
          setScene(s, false);
          await sleep(s.blocked ? 3600 : 3000);
        }
        running = false;
      }
    }
  }
})();
