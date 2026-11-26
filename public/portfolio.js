'use strict';
// Public portfolio behavior: collection filters, lightbox, and the two animated layouts (3D carousel, spotlight).
// Everything is read from the server-rendered (already escaped) DOM and written back via textContent.
// window.Artfolio.setLook(template, theme) switches layout/colors in place; the editor's live preview uses it.
(function () {
  const body = document.body;
  body.classList.add('fx'); // animated states only apply once JS is running
  const TEMPLATES = ['gallery', 'grid', 'editorial', 'studio', 'carousel', 'spotlight'];
  const THEMES = ['chalk', 'ink', 'sage', 'midnight'];
  const BIG_IMAGES = new Set(['editorial', 'carousel', 'spotlight']);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const works = [...document.querySelectorAll('.work')];
  const visibleWorks = () => works.filter((w) => !w.hidden);
  const current = (list, prefix) => list.find((t) => body.classList.contains(prefix + t));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lightboxOpen = () => !!document.querySelector('.lightbox:not([hidden])');
  const typing = (e) => /^(input|textarea|select)$/i.test(e.target.tagName);

  // ---------- layout manager ----------
  let teardown = null;
  function upgradeImages() {
    if (!BIG_IMAGES.has(current(TEMPLATES, 'tpl-'))) return;
    for (const w of works) {
      const img = w.querySelector('img');
      if (img && img.dataset.full && img.getAttribute('src') !== img.dataset.full) img.src = img.dataset.full;
    }
  }
  function layout() {
    if (teardown) teardown();
    teardown = null;
    upgradeImages();
    const t = current(TEMPLATES, 'tpl-');
    if (t === 'carousel') teardown = initCarousel();
    else if (t === 'spotlight') teardown = initSpotlight();
  }
  function setLook(template, theme) {
    if (TEMPLATES.includes(template)) {
      TEMPLATES.forEach((t) => body.classList.remove('tpl-' + t));
      body.classList.add('tpl-' + template);
    }
    if (THEMES.includes(theme)) {
      THEMES.forEach((t) => body.classList.remove('pal-' + t));
      body.classList.add('pal-' + theme);
    }
    layout();
  }
  window.Artfolio = { setLook };

  // ---------- filters ----------
  const buttons = [...document.querySelectorAll('.filters button')];
  buttons.forEach((btn) =>
    btn.addEventListener('click', () => {
      const f = btn.dataset.filter;
      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      works.forEach((w) => (w.hidden = f !== '' && w.dataset.collection !== f));
      layout();
    })
  );

  // ---------- 3D carousel ----------
  function initCarousel() {
    const stage = document.querySelector('.works');
    const list = visibleWorks();
    const n = list.length;
    if (!stage || !n) return null;
    const off = []; // [target, type, handler, opts] for clean teardown
    const on = (t, type, fn, opts) => {
      t.addEventListener(type, fn, opts);
      off.push([t, type, fn, opts]);
    };
    let target = 0, pos = 0, raf = 0, shown = -1, suppress = false;

    // caption + controls under the stage
    const ui = document.createElement('div');
    ui.className = 'car-ui';
    const cap = document.createElement('div');
    cap.className = 'car-cap';
    const capTitle = document.createElement('h2');
    const capText = document.createElement('p');
    cap.append(capTitle, capText);
    const nav = document.createElement('div');
    nav.className = 'car-nav';
    const mkBtn = (label, text, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', label);
      b.textContent = text;
      b.addEventListener('click', fn);
      return b;
    };
    const dots = document.createElement('div');
    dots.className = 'car-dots';
    const dotBtns = list.map((_, i) => {
      const d = document.createElement('button');
      d.type = 'button';
      d.setAttribute('aria-label', `Show piece ${i + 1} of ${n}`);
      d.addEventListener('click', () => go(i));
      dots.append(d);
      return d;
    });
    nav.append(mkBtn('Previous piece', '‹', () => go(target - 1)), dots, mkBtn('Next piece', '›', () => go(target + 1)));
    ui.append(cap, nav);
    stage.after(ui);

    function place() {
      for (let i = 0; i < n; i++) {
        const w = list[i];
        const d = i - pos, a = Math.abs(d), s = Math.sign(d);
        const cw = w.offsetWidth || 320;
        const x = s * (Math.min(a, 1) * cw * 0.9 + Math.max(0, a - 1) * cw * 0.3);
        const ry = -clamp(d, -1, 1) * 48;
        const z = -Math.min(a, 2) * 130;
        const sc = 1 - Math.min(a, 3) * 0.05;
        w.style.transform = `translateX(${x}px) translateZ(${z}px) rotateY(${ry}deg) scale(${sc})`;
        w.style.opacity = String(clamp(3 - a, 0, 1));
        w.style.zIndex = String(100 - Math.round(a * 10));
        w.style.filter = a < 0.01 ? '' : `brightness(${1 - Math.min(a, 1) * 0.38})`;
        w.style.visibility = a > 3 ? 'hidden' : 'visible';
        w.style.pointerEvents = a > 3 ? 'none' : '';
      }
      const c = clamp(Math.round(pos), 0, n - 1);
      if (c !== shown) {
        shown = c;
        const fig = list[c];
        capTitle.textContent = fig.querySelector('figcaption h2')?.textContent || '';
        capText.textContent = fig.querySelector('figcaption p')?.innerText || '';
        dotBtns.forEach((d, i) => (i === c ? d.setAttribute('aria-current', 'true') : d.removeAttribute('aria-current')));
      }
    }
    function tick() {
      raf = 0;
      pos += (target - pos) * 0.17;
      if (Math.abs(target - pos) < 0.002) pos = target;
      place();
      if (pos !== target) raf = requestAnimationFrame(tick);
    }
    function go(i) {
      target = clamp(i, 0, n - 1);
      if (reduce) {
        pos = target;
        place();
      } else if (!raf) raf = requestAnimationFrame(tick);
    }

    // drag / swipe
    on(stage, 'pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const startX = e.clientX, startPos = pos;
      const cw = list[0].offsetWidth || 320;
      let moved = false;
      const move = (ev) => {
        const dx = ev.clientX - startX;
        if (!moved && Math.abs(dx) > 6) {
          moved = true;
          stage.classList.add('drag');
        }
        if (moved) {
          pos = target = clamp(startPos - dx / (cw * 0.6), -0.3, n - 0.7);
          place();
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        stage.classList.remove('drag');
        if (moved) {
          suppress = true;
          setTimeout(() => (suppress = false), 0);
          go(Math.round(pos));
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
    // a click on a side card brings it to the center; a click on the centered card opens the lightbox
    on(
      stage,
      'click',
      (e) => {
        if (suppress) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        const fig = e.target.closest('.work');
        const i = list.indexOf(fig);
        if (i >= 0 && i !== Math.round(target)) {
          e.preventDefault();
          e.stopPropagation();
          go(i);
        }
      },
      true
    );
    on(document, 'keydown', (e) => {
      if (lightboxOpen() || typing(e)) return;
      if (e.key === 'ArrowLeft') go(target - 1);
      else if (e.key === 'ArrowRight') go(target + 1);
    });
    let wheelLock = 0;
    on(
      stage,
      'wheel',
      (e) => {
        if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || Math.abs(e.deltaX) < 20) return;
        e.preventDefault();
        if (Date.now() - wheelLock < 350) return;
        wheelLock = Date.now();
        go(target + Math.sign(e.deltaX));
      },
      { passive: false }
    );
    on(window, 'resize', place);

    pos = target = 0;
    place();
    return () => {
      cancelAnimationFrame(raf);
      off.forEach(([t, type, fn, opts]) => t.removeEventListener(type, fn, opts));
      ui.remove();
      stage.classList.remove('drag');
      list.forEach((w) => {
        ['transform', 'opacity', 'zIndex', 'filter', 'visibility', 'pointerEvents'].forEach((p) => (w.style[p] = ''));
        if (!w.getAttribute('style')) w.removeAttribute('style');
      });
    };
  }

  // ---------- spotlight ----------
  function initSpotlight() {
    const list = visibleWorks();
    if (!list.length) return null;
    const ratios = new Map(list.map((w) => [w, 0]));
    const dots = document.createElement('nav');
    dots.className = 'spot-dots';
    dots.setAttribute('aria-label', 'Jump to piece');
    const dotBtns = list.map((w, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', `Go to piece ${i + 1} of ${list.length}`);
      b.addEventListener('click', () => w.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' }));
      dots.append(b);
      return b;
    });
    document.body.append(dots);

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          ratios.set(e.target, e.intersectionRatio);
          if (e.intersectionRatio > 0.3) e.target.classList.add('in');
        }
        let best = 0;
        list.forEach((w, i) => ratios.get(w) > ratios.get(list[best]) && (best = i));
        dotBtns.forEach((d, i) => (i === best ? d.setAttribute('aria-current', 'true') : d.removeAttribute('aria-current')));
      },
      { threshold: [0, 0.15, 0.3, 0.5, 0.75, 1] }
    );
    list.forEach((w) => io.observe(w));
    if (reduce) list.forEach((w) => w.classList.add('in'));

    // gentle parallax on the image block
    let ticking = false;
    const parallax = () => {
      ticking = false;
      const vh = window.innerHeight;
      for (const w of list) {
        const r = w.getBoundingClientRect();
        if (r.bottom < 0 || r.top > vh) continue;
        const off = (r.top + r.height / 2 - vh / 2) / vh; // -1..1 around the screen center
        const cover = w.querySelector('.cover');
        if (cover) cover.style.transform = `translateY(${(off * -34).toFixed(1)}px)`;
      }
    };
    const onScroll = () => {
      if (!ticking && !reduce) {
        ticking = true;
        requestAnimationFrame(parallax);
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    parallax();
    return () => {
      io.disconnect();
      window.removeEventListener('scroll', onScroll);
      dots.remove();
      list.forEach((w) => {
        w.classList.remove('in');
        const cover = w.querySelector('.cover');
        if (cover) cover.style.transform = '';
      });
    };
  }

  // ---------- lightbox ----------
  let box, imgEl, titleEl, descEl, posEl, items = [], idx = 0, lastFocus = null;

  const visibleLinks = () => [...document.querySelectorAll('a.lb')].filter((a) => !a.closest('.work').hidden);

  function build() {
    box = document.createElement('div');
    box.className = 'lightbox';
    box.hidden = true;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Image viewer');
    const mk = (cls, label, text) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.setAttribute('aria-label', label);
      b.textContent = text;
      return b;
    };
    const close = mk('close', 'Close', '×');
    const prev = mk('prev', 'Previous image', '‹');
    const next = mk('next', 'Next image', '›');
    posEl = document.createElement('div');
    posEl.className = 'pos';
    const stage = document.createElement('div');
    stage.className = 'stage';
    imgEl = document.createElement('img');
    stage.append(imgEl);
    const info = document.createElement('div');
    info.className = 'info';
    titleEl = document.createElement('h2');
    descEl = document.createElement('p');
    info.append(titleEl, descEl);
    box.append(posEl, close, prev, next, stage, info);
    document.body.append(box);

    close.addEventListener('click', hide);
    prev.addEventListener('click', () => go(-1));
    next.addEventListener('click', () => go(1));
    box.addEventListener('click', (e) => {
      if (e.target === box || e.target === stage) hide();
    });
    document.addEventListener('keydown', (e) => {
      if (box.hidden) return;
      if (e.key === 'Escape') hide();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'Tab') {
        // keep focus inside the dialog
        const f = [...box.querySelectorAll('button')].filter((b) => !b.hidden); // hidden prev/next can't take focus
        const i = f.indexOf(document.activeElement);
        e.preventDefault();
        f[i < 0 ? 0 : (i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
      }
    });
    let startX = null;
    box.addEventListener('touchstart', (e) => (startX = e.touches[0].clientX), { passive: true });
    box.addEventListener('touchend', (e) => {
      if (startX === null) return;
      const dx = e.changedTouches[0].clientX - startX;
      if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
      startX = null;
    });
  }

  function render() {
    const a = items[idx];
    const fig = a.closest('.work');
    imgEl.src = a.href;
    imgEl.alt = fig.querySelector('img').alt;
    titleEl.textContent = fig.querySelector('figcaption h2')?.textContent || '';
    descEl.textContent = fig.querySelector('figcaption p')?.innerText || '';
    posEl.textContent = items.length > 1 ? `${idx + 1} / ${items.length}` : '';
    box.querySelector('.prev').hidden = box.querySelector('.next').hidden = items.length < 2;
    if (items.length > 1) new Image().src = items[(idx + 1) % items.length].href; // warm the cache
  }
  function go(d) {
    idx = (idx + d + items.length) % items.length;
    render();
  }
  function show(a) {
    if (!box) build();
    items = visibleLinks();
    idx = Math.max(0, items.indexOf(a));
    lastFocus = document.activeElement;
    box.hidden = false;
    document.body.style.overflow = 'hidden';
    render();
    box.querySelector('.close').focus();
  }
  function hide() {
    box.hidden = true;
    imgEl.removeAttribute('src');
    document.body.style.overflow = '';
    lastFocus?.focus();
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a.lb');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    show(a);
  });

  layout();
})();
