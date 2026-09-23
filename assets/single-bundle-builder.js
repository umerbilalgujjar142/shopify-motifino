/* ============================================================
   SINGLE BUNDLE BUILDER — single-bundle-builder.js
   Product-page style single-belt configurator with dropdown
   selectors and dynamic gallery. Reuses bundle-builder cart
   logic (same catalog.json and media.json).
   ============================================================ */

(function () {
  'use strict';

  /* ── Data ───────────────────────────────────────────────── */
  const BUCKLES = {
    'buckle-1': { name: 'Classic' },
    'buckle-2': { name: 'Zeno Silver' },
    'buckle-3': { name: 'Zeno Gold' },
    'buckle-4': { name: 'Krono' },
  };

  const STRAPS = {
    'strap-nero':    { name: 'Nero',            hex: '#1a1a1a' },
    'strap-marrone': { name: 'Testa di Moro',            hex: '#6b3a2a' },
    'strap-cognac':  { name: 'Cognac',           hex: '#c07840' },
    'strap-cuoio':   { name: 'Bianco',            hex: '#f0ede8' },
    'strap-beige':   { name: 'Sabbia',             hex: '#d4bc94' },
    'strap-rosso':   { name: 'Marrone Croc',  hex: '#8b1a1a' },
    'strap-verde':   { name: 'Nero Croc',  hex: '#2d5a1b' },
    'strap-blu':     { name: 'Blue Navy',             hex: '#1a3a6b' },
    'strap-grigio':  { name: 'Grigio',             hex: '#888888' },
  };

  /* Live tier prices — overwritten by fetchTierPrices() */
  const TIER_PRICES = {
    single:   49.99,
    double:   89.98,
    triple:   124.97,
    infinity: 154.96,
    extra:    29.99,
  };

  /* ── State ──────────────────────────────────────────────── */
  const state = {
    strap:        'strap-nero',
    buckle:       'buckle-1',
    length:       '130cm',
    price:        49.99,
  };

  let _media              = null;
  let _catalog            = null;
  let _singleComparePrice = null;

  /* ── Fetch helpers ──────────────────────────────────────── */
  async function fetchMedia() {
    const root = document.getElementById('sbb-root');
    const url  = root && root.dataset.mediaUrl;
    if (!url) return;
    try {
      const res = await fetch(url);
      if (res.ok) _media = await res.json();
    } catch (e) {
      console.warn('[SBB] Media not loaded:', e);
    }
  }

  async function fetchCatalog() {
    const root = document.getElementById('sbb-root');
    const url  = root && root.dataset.catalogUrl;
    if (!url) return;
    try {
      const res = await fetch(url);
      if (res.ok) _catalog = await res.json();
    } catch (e) {
      console.warn('[SBB] Catalog not loaded:', e);
    }
  }

  function getBundleVariantId() {
    const fromSettings = window.SBB_VARIANTS && Number(window.SBB_VARIANTS.bundle_single);
    if (fromSettings && fromSettings > 0) return fromSettings;
    return (_catalog && Number(_catalog['SET-CINTURA-SINGOLA'])) || 0;
  }

  /* Fetch live prices for all tiers — mirrors bundle-builder fetchCatalogPrices() */
  async function fetchTierPrices() {
    if (!_catalog) return;
    const map = [
      { key: 'SET-CINTURA-SINGOLA',  tier: 'single' },
      { key: 'SET-CINTURE-DOPPIO',   tier: 'double' },
      { key: 'SET-CINTURE-TRIPLO',   tier: 'triple' },
      { key: 'SET-CINTURE-INFINITY', tier: 'infinity' },
      { key: 'SET-CINTURE-EXTRA',    tier: 'extra' },
    ];
    await Promise.all(map.map(async function (m) {
      const vid = m.tier === 'single'
        ? getBundleVariantId()
        : Number(_catalog[m.key]);
      if (!vid || vid <= 0) return;
      try {
        const res   = await fetch(_u('/variants/' + vid + '.js'));
        if (!res.ok) return;
        const data  = await res.json();
        const cents = Number(data.price);
        if (Number.isFinite(cents) && cents > 0) TIER_PRICES[m.tier] = cents / 100;
        if (m.tier === 'single') {
          const cc = Number(data.compare_at_price);
          _singleComparePrice = (Number.isFinite(cc) && cc > cents) ? cc / 100 : null;
        }
      } catch (_) { /* silent */ }
    }));
  }

  /* The storefront runs under a locale prefix (/it-it/). An unprefixed URL costs a
     302 round trip on every single request, so build them all from Shopify.routes. */
  function _u(path) {
    var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
    return root.replace(/\/+$/, '') + path;
  }

  /* Count belts already in the Shopify cart */
  async function fetchCartBeltCount() {
    try {
      const res = await fetch(_u('/cart.js'));
      if (!res.ok) return 0;
      const cart = await res.json();
      let count = 0;
      (cart.items || []).forEach(function (item) {
        if (!item.properties) return;
        Object.keys(item.properties).forEach(function (k) {
          if (k.indexOf('Cintura ') === 0 && k.indexOf(' - Pelle') > -1) count++;
        });
      });
      return count;
    } catch (_) { return 0; }
  }

  /* Marginal price of adding one more belt given current cart count */
  function getMarginalPrice(cartBeltCount) {
    if (cartBeltCount === 0) return TIER_PRICES.single;
    if (cartBeltCount === 1) return +((TIER_PRICES.double   - TIER_PRICES.single).toFixed(2));
    if (cartBeltCount === 2) return +((TIER_PRICES.triple   - TIER_PRICES.double).toFixed(2));
    if (cartBeltCount === 3) return +((TIER_PRICES.infinity - TIER_PRICES.triple).toFixed(2));
    return TIER_PRICES.extra;
  }

  /* ── Combo helpers ──────────────────────────────────────── */
  function comboKey() {
    return state.strap + '__' + state.length.replace('cm', '') + '__' + state.buckle;
  }

  function getCombo() {
    return (_media && _media.combinations && _media.combinations[comboKey()]) || null;
  }

  /* ── Gallery ────────────────────────────────────────────── */
  function renderGallery() {
    const combo       = getCombo();
    const mainImg     = document.getElementById('sbb-main-img');
    const placeholder = document.getElementById('sbb-gallery-placeholder');
    const wornImg     = document.getElementById('sbb-worn-img');
    const wornBtn     = document.getElementById('sbb-worn-toggle');

    const src     = (combo && combo.photo) || '';
    const wornSrc = (combo && combo.worn)  || '';

    if (src && mainImg) {
      mainImg.style.opacity = '0';
      mainImg.src = src;
      mainImg.onload  = function () { mainImg.style.opacity = '1'; };
      mainImg.onerror = function () { mainImg.style.display = 'none'; if (placeholder) placeholder.style.display = ''; };
      mainImg.style.display = '';
      if (placeholder) placeholder.style.display = 'none';
    } else {
      if (mainImg) mainImg.style.display = 'none';
      if (placeholder) placeholder.style.display = '';
    }

    if (wornImg) wornImg.src = wornSrc;
    if (wornBtn) wornBtn.style.display = wornSrc ? '' : 'none';

    document.dispatchEvent(new CustomEvent('sbb:gallery-update'));
  }

  /* ── Title ──────────────────────────────────────────────── */
  function updateTitle() {
    const titleEl = document.getElementById('sbb-title');
    if (!titleEl) return;
    const baseTitle = titleEl.dataset.baseTitle || 'Set Cintura Singola';
    const strapName  = (STRAPS[state.strap]  || {}).name || '';
    const buckleName = (BUCKLES[state.buckle] || {}).name || '';
    if (strapName && buckleName) {
      titleEl.textContent = buckleName + ' - ' + strapName;
    } else {
      titleEl.textContent = baseTitle;
    }
  }

  /* ── Price ──────────────────────────────────────────────── */
  function updatePrice() {
    const el = document.getElementById('sbb-price');
    if (el) el.textContent = '€ ' + state.price.toFixed(2).replace('.', ',');
  }

  /* ── Strap dropdown ─────────────────────────────────────── */
  function renderStrapDropdown() {
    var strapPairs = [
      { listId: 'sbb-strap-list',   dropId: 'sbb-strap-dropdown'   },
      { listId: 'sbb-strap-list-d', dropId: 'sbb-strap-dropdown-d' },
    ];
    const len = state.length.replace('cm', '');

    strapPairs.forEach(function (ids) {
      const list = document.getElementById(ids.listId);
      if (!list) return;

      list.innerHTML = Object.entries(STRAPS).map(function ([key, strap]) {
        const imgSrc = _media && _media.straps && _media.straps[key] && _media.straps[key][len]
          ? _media.straps[key][len] : '';
        return '<div class="sbb-dropdown__option' + (key === state.strap ? ' is-selected' : '') + '" data-value="' + key + '">'
          + (imgSrc
            ? '<img class="sbb-dropdown__opt-img" src="' + imgSrc + '" alt="' + strap.name + '" loading="lazy">'
            : '<div class="sbb-dropdown__opt-img"></div>')
          + '<div class="sbb-dropdown__opt-swatch" style="background:' + strap.hex + '"></div>'
          + '<span class="sbb-dropdown__opt-name">' + strap.name + '</span>'
          + '</div>';
      }).join('');

      list.querySelectorAll('.sbb-dropdown__option').forEach(function (opt) {
        opt.addEventListener('click', function () {
          state.strap = opt.dataset.value;
          warmCombination();
          closeDropdown('sbb-strap-dropdown');
          closeDropdown('sbb-strap-dropdown-d');
          updateStrapTrigger();
          renderStrapDropdown();
          renderGallery();
          updateTitle();
        });
      });
    });

    updateStrapTrigger();
  }

  function updateStrapTrigger() {
    const strap  = STRAPS[state.strap];
    if (!strap) return;
    const len    = state.length.replace('cm', '');
    const imgSrc = _media && _media.straps && _media.straps[state.strap] && _media.straps[state.strap][len]
      ? _media.straps[state.strap][len] : '';

    ['sbb-strap-dropdown', 'sbb-strap-dropdown-d'].forEach(function (dropId) {
      const trigger = document.querySelector('#' + dropId + ' .sbb-dropdown__trigger');
      if (!trigger) return;
      const imgEl    = trigger.querySelector('.sbb-dropdown__trigger-img');
      const swatchEl = trigger.querySelector('.sbb-dropdown__trigger-swatch');
      const nameEl   = trigger.querySelector('.sbb-dropdown__trigger-name');

      if (imgEl)    { imgEl.src = imgSrc; imgEl.style.display = imgSrc ? '' : 'none'; }
      if (swatchEl) { swatchEl.style.background = strap.hex; }
      if (nameEl)   { nameEl.textContent = strap.name; }
    });
  }

  /* ── Buckle dropdown ────────────────────────────────────── */
  function renderBuckleDropdown() {
    var bucklePairs = [
      { listId: 'sbb-buckle-list',   dropId: 'sbb-buckle-dropdown'   },
      { listId: 'sbb-buckle-list-d', dropId: 'sbb-buckle-dropdown-d' },
    ];

    bucklePairs.forEach(function (ids) {
      const list = document.getElementById(ids.listId);
      if (!list) return;

      list.innerHTML = Object.entries(BUCKLES).map(function ([key, buckle]) {
        const imgSrc = _media && _media.buckles && _media.buckles[key] ? _media.buckles[key] : '';
        return '<div class="sbb-dropdown__option' + (key === state.buckle ? ' is-selected' : '') + '" data-value="' + key + '">'
          + (imgSrc
            ? '<img class="sbb-dropdown__opt-img" src="' + imgSrc + '" alt="' + buckle.name + '" loading="lazy">'
            : '<div class="sbb-dropdown__opt-img"></div>')
          + '<span class="sbb-dropdown__opt-name">' + buckle.name + '</span>'
          + '</div>';
      }).join('');

      list.querySelectorAll('.sbb-dropdown__option').forEach(function (opt) {
        opt.addEventListener('click', function () {
          state.buckle = opt.dataset.value;
          warmCombination();
          closeDropdown('sbb-buckle-dropdown');
          closeDropdown('sbb-buckle-dropdown-d');
          updateBuckleTrigger();
          renderBuckleDropdown();
          renderGallery();
          updateTitle();
        });
      });
    });

    updateBuckleTrigger();
  }

  function updateBuckleTrigger() {
    const buckle = BUCKLES[state.buckle];
    if (!buckle) return;
    const imgSrc = _media && _media.buckles && _media.buckles[state.buckle]
      ? _media.buckles[state.buckle] : '';

    ['sbb-buckle-dropdown', 'sbb-buckle-dropdown-d'].forEach(function (dropId) {
      const trigger = document.querySelector('#' + dropId + ' .sbb-dropdown__trigger');
      if (!trigger) return;
      const imgEl  = trigger.querySelector('.sbb-dropdown__trigger-img');
      const nameEl = trigger.querySelector('.sbb-dropdown__trigger-name');

      if (imgEl)  { imgEl.src = imgSrc; imgEl.style.display = imgSrc ? '' : 'none'; }
      if (nameEl) { nameEl.textContent = buckle.name; }
    });
  }

  /* ── Dropdown open/close ────────────────────────────────── */
  function openDropdown(id) {
    document.querySelectorAll('.sbb-dropdown.is-open').forEach(function (d) {
      if (d.id !== id) {
        d.classList.remove('is-open');
        const t = d.querySelector('.sbb-dropdown__trigger');
        if (t) t.setAttribute('aria-expanded', 'false');
      }
    });
    const dropdown = document.getElementById(id);
    if (!dropdown) return;
    const wasOpen = dropdown.classList.contains('is-open');
    dropdown.classList.toggle('is-open', !wasOpen);
    const trigger = dropdown.querySelector('.sbb-dropdown__trigger');
    if (trigger) trigger.setAttribute('aria-expanded', String(!wasOpen));
  }

  function closeDropdown(id) {
    const dropdown = document.getElementById(id);
    if (!dropdown) return;
    dropdown.classList.remove('is-open');
    const trigger = dropdown.querySelector('.sbb-dropdown__trigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }

  /* Warms the combination's product JSON while the customer is still choosing,
     so the add is a single request. */
  function warmCombination() {
    if (window.MotifinoBelt && state.strap && state.buckle) {
      window.MotifinoBelt.prefetchCombination(state.strap, state.buckle);
    }
  }

  /* ── ATC ────────────────────────────────────────────────── */
  async function addToCart() {
    const btn      = document.getElementById('sbb-atc-btn');
    const origHTML = btn ? btn.innerHTML : '';
    const spinSVG  = '<svg class="sbb-spinner" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>';

    if (btn) { btn.disabled = true; btn.innerHTML = spinSVG + ' Aggiungendo al carrello...'; }

    try {
      if (!window.MotifinoBelt) throw new Error('belt_combination_js_missing');

      /* One combination product (belt + buckle already combined) in the chosen
         length, plus one free Privilege Card Black per belt. Nothing else. */
      await window.MotifinoBelt.addBelt({
        strap:  state.strap,
        buckle: state.buckle,
        length: state.length,
      });

      window.location.href = _u('/cart');
    } catch (e) {
      console.error('[SBB] Add to cart failed:', e, e && e.body);
      const desc = (e && e.body && (e.body.description || e.body.message)) || '';
      showToast(desc || 'Impossibile aggiungere al carrello. Riprova.');
      if (btn && origHTML) { btn.disabled = false; btn.innerHTML = origHTML; }
    }
  }

  /* ── Toast ──────────────────────────────────────────────── */
  function showToast(msg) {
    let toast = document.getElementById('sbb-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'sbb-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    setTimeout(function () { toast.style.opacity = '0'; }, 3500);
  }

  /* ── Accordion tabs ─────────────────────────────────────── */
  function initTabs() {
    document.querySelectorAll('.sbb-tab__trigger').forEach(function (trigger) {
      trigger.addEventListener('click', function () {
        const tab = trigger.closest('.sbb-tab');
        if (!tab) return;
        const isOpen = tab.classList.contains('is-open');
        document.querySelectorAll('.sbb-tab').forEach(function (t) {
          t.classList.remove('is-open');
        });
        if (!isOpen) tab.classList.add('is-open');
      });
    });
    /* Open first tab by default on mobile */
    const first = document.querySelector('.sbb-tab');
    if (first) first.classList.add('is-open');
  }

  /* ── Init ───────────────────────────────────────────────── */
  async function init() {
    const root = document.getElementById('sbb-root');
    if (!root) return;

    await Promise.all([fetchMedia(), fetchCatalog()]);

    /* Render dynamic parts */
    renderStrapDropdown();
    renderBuckleDropdown();
    renderGallery();
    updateTitle();
    updatePrice();

    /* Dropdown triggers */
    document.querySelectorAll('.sbb-dropdown__trigger').forEach(function (trigger) {
      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        const dropdown = trigger.closest('.sbb-dropdown');
        if (dropdown) openDropdown(dropdown.id);
      });
    });

    /* Close on outside click */
    document.addEventListener('click', function () {
      document.querySelectorAll('.sbb-dropdown.is-open').forEach(function (d) {
        d.classList.remove('is-open');
        const t = d.querySelector('.sbb-dropdown__trigger');
        if (t) t.setAttribute('aria-expanded', 'false');
      });
    });
    /* Prevent list click from bubbling to document */
    document.querySelectorAll('.sbb-dropdown__list').forEach(function (list) {
      list.addEventListener('click', function (e) { e.stopPropagation(); });
    });

    /* Size pills */
    document.querySelectorAll('.sbb-pill').forEach(function (pill) {
      pill.addEventListener('click', function () {
        const len = pill.dataset.length;
        if (!len || len === state.length) return;
        state.length = len;
        document.querySelectorAll('.sbb-pill').forEach(function (p) {
          p.classList.toggle('is-selected', p.dataset.length === len);
        });
        updateStrapTrigger();
        renderStrapDropdown();
        renderGallery();
      });
    });

    /* ATC button */
    const atcBtn = document.getElementById('sbb-atc-btn');
    if (atcBtn) atcBtn.addEventListener('click', addToCart);
    warmCombination();

    /* Accordion tabs */
    initTabs();

    /* Put buckle + strap dropdowns side-by-side (mobile row) */
    var buckleGroup = document.querySelector('#sbb-buckle-dropdown') &&
      document.querySelector('#sbb-buckle-dropdown').closest('.sbb-selector-group');
    var strapGroup  = document.querySelector('#sbb-strap-dropdown') &&
      document.querySelector('#sbb-strap-dropdown').closest('.sbb-selector-group');
    if (buckleGroup && strapGroup && buckleGroup.parentNode === strapGroup.parentNode
        && !buckleGroup.parentNode.classList.contains('sbb-dropdowns-row')) {
      var dropRow = document.createElement('div');
      dropRow.className = 'sbb-dropdowns-row';
      buckleGroup.parentNode.insertBefore(dropRow, buckleGroup);
      dropRow.appendChild(buckleGroup);
      dropRow.appendChild(strapGroup);
      buckleGroup.classList.remove('sbb-selector-group--mobile-only');
      strapGroup.classList.remove('sbb-selector-group--mobile-only');
    }

    /* Put desktop buckle + strap dropdowns side-by-side (desktop row) */
    var buckleGroupD = document.querySelector('#sbb-buckle-dropdown-d') &&
      document.querySelector('#sbb-buckle-dropdown-d').closest('.sbb-selector-group');
    var strapGroupD  = document.querySelector('#sbb-strap-dropdown-d') &&
      document.querySelector('#sbb-strap-dropdown-d').closest('.sbb-selector-group');
    if (buckleGroupD && strapGroupD
        && !buckleGroupD.parentNode.classList.contains('sbb-dropdowns-row')) {
      var dropRowD = document.createElement('div');
      dropRowD.className = 'sbb-dropdowns-row sbb-dropdowns-row--desktop';
      buckleGroupD.parentNode.insertBefore(dropRowD, buckleGroupD);
      dropRowD.appendChild(buckleGroupD);
      dropRowD.appendChild(strapGroupD);
      buckleGroupD.classList.remove('sbb-selector-group--desktop-only');
      strapGroupD.classList.remove('sbb-selector-group--desktop-only');
    }
  }

  /* ── Boot ───────────────────────────────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

/* ── Carousel initialiser (runs independently) ───────────── */
(function () {
  function initCarousel(el) {
    var track   = el.querySelector('.sbb-carousel__track');
    var slides  = el.querySelectorAll('.sbb-carousel__slide');
    var dots    = el.querySelectorAll('.sbb-carousel__dot');
    var btnPrev = el.querySelector('.sbb-carousel__btn--prev');
    var btnNext = el.querySelector('.sbb-carousel__btn--next');
    var total   = slides.length;
    var current = 0;
    var timer   = null;
    var autoplay  = el.dataset.autoplay === 'true';
    var speed     = parseInt(el.dataset.speed, 10) || 4000;

    if (total <= 1) return;

    function goTo(idx) {
      current = (idx + total) % total;
      track.style.transform = 'translateX(-' + (current * 100) + '%)';
      dots.forEach(function (d, i) { d.classList.toggle('is-active', i === current); });
    }

    if (btnPrev) btnPrev.addEventListener('click', function () { goTo(current - 1); resetTimer(); });
    if (btnNext) btnNext.addEventListener('click', function () { goTo(current + 1); resetTimer(); });
    dots.forEach(function (d) {
      d.addEventListener('click', function () { goTo(parseInt(d.dataset.index, 10)); resetTimer(); });
    });

    function resetTimer() {
      if (!autoplay) return;
      clearInterval(timer);
      timer = setInterval(function () { goTo(current + 1); }, speed);
    }

    if (autoplay) resetTimer();
  }

  function initAllCarousels() {
    document.querySelectorAll('.sbb-carousel').forEach(function (el) {
      if (!el.dataset.carouselInit) {
        el.dataset.carouselInit = '1';
        initCarousel(el);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAllCarousels);
  } else {
    initAllCarousels();
  }
})();

/* ── Worn image toggle ───────────────────────────────────── */
(function () {
  function init() {
    var btn     = document.getElementById('sbb-worn-toggle');
    var mainImg = document.getElementById('sbb-main-img');
    var wornImg = document.getElementById('sbb-worn-img');
    if (!btn || !wornImg) return;

    var isWorn = false;

    function setWorn(worn) {
      isWorn = worn;
      if (worn) {
        if (mainImg) mainImg.style.display = 'none';
        wornImg.style.display = '';
        btn.classList.add('is-worn');
        btn.querySelector('.sbb-worn-btn__label').textContent = btn.dataset.labelBack;
      } else {
        wornImg.style.display = 'none';
        if (mainImg) mainImg.style.display = '';
        btn.classList.remove('is-worn');
        btn.querySelector('.sbb-worn-btn__label').textContent = btn.dataset.label;
      }
    }

    btn.addEventListener('click', function () { setWorn(!isWorn); });
    document.addEventListener('sbb:gallery-update', function () {
      // Keep worn view active when selection changes — image src is already updated by renderGallery
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
