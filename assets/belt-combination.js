/* ============================================================
   MOTIFINO — BELT COMBINATION CART LOGIC
   ============================================================
   Single source of truth for adding belts to the cart.

   One belt = one "Combinazione cintura" product (belt + buckle
   already combined, e.g. "Black - Classic Matt") in the chosen
   length variant (130-cm / 150-cm).

   One combination = one box = one Privilege Card Black.
   The card line quantity is always kept equal to the total
   number of combination units in the cart.

   Nothing else is added: no SET-CINTURA-* tier product, no
   hidden strap/buckle component lines, no box, no warranty card.
   Inventory is managed in the Motifino ERP, so the cart and the
   checkout contain exactly the same line items.
   ============================================================ */

(function () {
  'use strict';

  /* Several sections pull this asset in, so on the cart page the browser runs it
     more than once. Only the first run may take effect — a second would race the
     first and could add a duplicate card line. */
  if (window.MotifinoBelt) return;

  /* ── Product identification ─────────────────────────────── */
  /* Combination products carry this product type in Shopify. It is how a
     belt line is recognised in the cart, both here and in Liquid. */
  var COMBINATION_TYPE = 'Combinazione cintura';
  var PRIVILEGE_CARD_HANDLE = 'privilege-card-black';

  /* ── Builder key → product handle ───────────────────────── */
  var STRAP_SLUG = {
    'strap-nero': 'black',
    'strap-marrone': 'brown',
    'strap-cognac': 'cognac',
    'strap-cuoio': 'white',
    'strap-beige': 'sand',
    'strap-rosso': 'brown-crocodile',
    'strap-verde': 'black-crocodile',
    'strap-blu': 'blue',
    'strap-grigio': 'gray',
  };

  var BUCKLE_SLUG = {
    'buckle-1': 'classic-matt',
    'buckle-2': 'elegant-chrome-silver',
    'buckle-3': 'elegant-chrome-gold',
    'buckle-4': 'mirror-chrome',
  };

  /* Option values differ between stores ("130-cm", "130cm", "130 CM"), so lengths
     are compared on their digits only. */
  function lengthDigits(value) {
    return String(value == null ? '' : value).replace(/[^0-9]/g, '');
  }

  function optionValueForLength(length) {
    return (lengthDigits(length) || '130') + '-cm';
  }

  function handleFor(strapKey, buckleKey) {
    var s = STRAP_SLUG[strapKey];
    var b = BUCKLE_SLUG[buckleKey];
    if (!s || !b) return null;
    return s + '-' + b;
  }

  /* ── Product fetching (cached per page load) ────────────── */
  var _productCache = {};

  /* The storefront runs under a locale prefix (/it-it/). An unprefixed URL costs a
     302 round trip on every single request, so build them all from Shopify.routes. */
  function url(path) {
    var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
    return root.replace(/\/+$/, '') + path;
  }

  function fetchProduct(handle) {
    if (_productCache[handle]) return _productCache[handle];
    _productCache[handle] = fetch(url('/products/' + handle + '.js'))
      .then(function (res) {
        if (!res.ok) throw new Error('product_not_found:' + handle + ':' + res.status);
        return res.json();
      })
      .catch(function (e) {
        /* Don't poison the cache — a later retry should be able to succeed. */
        delete _productCache[handle];
        throw e;
      });
    return _productCache[handle];
  }

  /* Resolve a builder selection to a concrete Shopify variant. */
  function resolveCombination(strapKey, buckleKey, length) {
    var handle = handleFor(strapKey, buckleKey);
    if (!handle) return Promise.reject(new Error('unknown_combination:' + strapKey + '+' + buckleKey));

    var wanted = lengthDigits(length) || '130';

    return fetchProduct(handle).then(function (product) {
      var variants = product.variants || [];
      var variant = variants.filter(function (v) {
        var opts = v.options && v.options.length ? v.options : [v.option1, v.option2, v.option3];
        return opts.some(function (o) { return lengthDigits(o) === wanted; });
      })[0];

      /* Only a product with a single variant has no length to match. Anything else
         means the option value was not recognised, and shipping the wrong length is
         worse than failing the add. */
      if (!variant && variants.length === 1) variant = variants[0];
      if (!variant) throw new Error('no_variant:' + handle + ':' + wanted);

      return {
        handle: handle,
        productId: product.id,
        productTitle: product.title,
        variantId: variant.id,
        variantTitle: variant.title,
        price: variant.price,
        available: variant.available,
        image: variant.featured_image ? variant.featured_image.url : (product.featured_image || ''),
      };
    });
  }

  function privilegeCardVariantId() {
    /* Printed into the page by belt-card-sync.liquid so an add never waits on a lookup. */
    if (window.MOTIFINO_PRIVILEGE_CARD_VARIANT_ID) {
      return Promise.resolve(Number(window.MOTIFINO_PRIVILEGE_CARD_VARIANT_ID));
    }
    return fetchProduct(PRIVILEGE_CARD_HANDLE).then(function (product) {
      var variant = (product.variants || [])[0];
      if (!variant) throw new Error('no_privilege_card_variant');
      return variant.id;
    });
  }

  /* ── Cart inspection ────────────────────────────────────── */
  function getCart() {
    return fetch(url('/cart.js'), { headers: { Accept: 'application/json' } }).then(function (r) {
      return r.json();
    });
  }

  function isBeltItem(item) {
    return item && item.product_type === COMBINATION_TYPE;
  }

  function isPrivilegeCardItem(item) {
    return item && item.handle === PRIVILEGE_CARD_HANDLE;
  }

  /* Total number of belts in the cart — quantities included, so two units of
     the same combination count as two belts (two boxes, two cards). */
  function countBelts(cart) {
    return (cart.items || []).reduce(function (sum, item) {
      return isBeltItem(item) ? sum + item.quantity : sum;
    }, 0);
  }

  /* ── Privilege card sync ────────────────────────────────── */
  /* Keeps exactly one free Privilege Card Black per belt in the cart.
     Adds the line if missing, corrects the quantity if wrong, removes it
     when the last belt is gone. */
  /* `cart` skips the extra /cart.js round trip when the caller already has a fresh
     cart. `sections` is passed through so the answer can carry rendered HTML.
     Resolves to null when the card line was already correct. */
  /* Syncs run one at a time. Two overlapping syncs would each read a cart with no
     card line and each add one, doubling it — so callers queue behind each other
     instead of racing. */
  var _syncChain = Promise.resolve();
  var _syncPending = 0;

  function syncPrivilegeCard(cart, sections) {
    /* A cart handed in by the caller is only trustworthy while nothing else is
       queued; behind a pending sync it is already out of date. */
    var seed = _syncPending === 0 ? cart : null;

    _syncPending++;
    var run = _syncChain.then(function () {
      return runSync(seed, sections);
    });

    /* The chain must survive a failed sync, so it continues from a settled promise. */
    _syncChain = run.then(
      function () { _syncPending--; },
      function () { _syncPending--; }
    );

    return run;
  }

  function runSync(cart, sections) {
    var current = cart ? Promise.resolve(cart) : getCart();

    return current.then(function (c) {
      var belts = countBelts(c);
      /* Shopify splits one variant across several lines when the units carry
         different discount allocations, so the card can hold more than one. */
      var cardLines = (c.items || []).filter(isPrivilegeCardItem);
      var currentQty = cardLines.reduce(function (sum, item) { return sum + item.quantity; }, 0);

      if (currentQty === belts) return null;

      /* Existing lines → collapse them into the first and zero the rest, in one write. */
      if (cardLines.length) {
        var updates = {};
        cardLines.forEach(function (line, index) {
          updates[line.key] = index === 0 ? belts : 0;
        });
        return postCart(url('/cart/update.js'), { updates: updates }, sections);
      }

      if (belts === 0) return null;

      /* No line yet → add one with the right quantity. */
      return privilegeCardVariantId().then(function (variantId) {
        return postCart(url('/cart/add.js'), { items: [{ id: variantId, quantity: belts }] }, sections);
      });
    });
  }

  /* Our own cart writes carry this header so the interceptor below can tell them
     apart from the theme's and not sync in a loop. */
  var SYNC_HEADER = 'X-Motifino-Cart-Sync';

  function cartHeaders() {
    var h = { 'Content-Type': 'application/json', Accept: 'application/json' };
    h[SYNC_HEADER] = '1';
    return h;
  }

  function postCart(url, body, sections) {
    if (sections) body.sections = sections;
    return fetch(url, {
      method: 'POST',
      headers: cartHeaders(),
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  }

  /* Warms the product cache so a later add doesn't pay for the product fetch. */
  function prefetchCombination(strapKey, buckleKey) {
    var handle = handleFor(strapKey, buckleKey);
    if (handle) fetchProduct(handle).catch(function () {});
  }

  /* ── Section rendering ──────────────────────────────────── */
  /* Swaps in the section HTML the cart API returned. False means there was
     nothing to swap and the caller should fall back to a reload. */
  function renderSections(payload, ids) {
    var sections = payload && payload.sections;
    if (!sections) return false;

    var swapped = false;
    (ids || Object.keys(sections)).forEach(function (id) {
      var host = document.getElementById('shopify-section-' + id);
      var html = sections[id];
      if (!host || !html) return;
      var fresh = new DOMParser().parseFromString(html, 'text/html')
        .getElementById('shopify-section-' + id);
      host.innerHTML = fresh ? fresh.innerHTML : html;
      swapped = true;
    });

    /* The payload of a cart write is the cart itself, so hand it to the theme
       rather than firing cart:refresh, which costs another /cart.js read. */
    if (swapped) {
      if (payload && typeof payload.item_count === 'number') {
        document.dispatchEvent(new CustomEvent('cart:change', { detail: { cart: payload } }));
      } else {
        document.dispatchEvent(new CustomEvent('cart:refresh'));
      }
    }
    return swapped;
  }

  /* ── Add to cart ────────────────────────────────────────── */
  /* Adds one or more belts, then syncs the privilege card once.
     `belts` is an array of { strap, buckle, length }. `sections` is an optional
     comma-separated list of section ids to render back with the response. */
  function addBelts(belts, sections) {
    var list = (belts || []).filter(Boolean);
    if (!list.length) return Promise.reject(new Error('no_belts'));

    return Promise.all(
      list.map(function (b) {
        return resolveCombination(b.strap, b.buckle, b.length);
      })
    ).then(function (combos) {
      /* Merge duplicate combinations into a single quantity so Shopify
         doesn't have to reconcile them afterwards. */
      var byVariant = {};
      var order = [];
      combos.forEach(function (c) {
        if (!byVariant[c.variantId]) {
          byVariant[c.variantId] = 0;
          order.push(c.variantId);
        }
        byVariant[c.variantId] += 1;
      });

      var items = order.map(function (variantId) {
        return { id: Number(variantId), quantity: byVariant[variantId] };
      });

      /* One card per belt rides along in the same request when the card variant is
         known up front. Shopify merges it into any existing card line, so there is
         no cart read-back and no second write. The add is atomic: a sold-out belt
         adds nothing at all. */
      var cardId = Number(window.MOTIFINO_PRIVILEGE_CARD_VARIANT_ID) || 0;
      if (cardId) items.push({ id: cardId, quantity: list.length });

      var body = { items: items };
      if (sections) body.sections = sections;

      return fetch(url('/cart/add.js'), {
        method: 'POST',
        headers: cartHeaders(),
        body: JSON.stringify(body),
      }).then(function (resp) {
        if (resp.ok) return resp.json();
        return resp.json().catch(function () { return {}; }).then(function (body) {
          var err = new Error('cart_add_failed');
          err.status = resp.status;
          err.body = body;
          throw err;
        });
      }).then(function (added) {
        if (cardId) return added;
        return syncPrivilegeCard(null, sections).then(function (after) {
          return after || added;
        });
      });
    });
  }

  function addBelt(belt, sections) {
    return addBelts([belt], sections);
  }

  /* ── Keeping the card in step with every cart change ────── */
  /*
   * A belt can reach the cart without going through this module: its own product
   * page, a quick-buy, the cart drawer, the theme's own quantity controls. All of
   * those post to the cart API directly, which used to leave the card count stale
   * (two belts, one card).
   *
   * So the sync is driven by the cart itself rather than by the caller. Every cart
   * write is observed, and the cart page repairs itself on load.
   */

  var CART_WRITE = /\/cart\/(add|change|update|clear)(\.js)?(\?|$)/;
  var FIX_ATTEMPTS_KEY = 'motifino_card_fix_attempts';

  function isOurRequest(input, init) {
    var headers = (init && init.headers) || (input && input.headers);
    if (!headers) return false;
    try {
      if (typeof headers.get === 'function') return !!headers.get(SYNC_HEADER);
      return Object.keys(headers).some(function (k) {
        return k.toLowerCase() === SYNC_HEADER.toLowerCase();
      });
    } catch (_) {
      return false;
    }
  }

  function requestUrl(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    try { return String(input); } catch (_) { return ''; }
  }

  function requestMethod(input, init) {
    var m = (init && init.method) || (input && input.method) || 'GET';
    return String(m).toUpperCase();
  }

  function onCartPage() {
    return window.location.pathname.replace(/\/+$/, '').split('/').pop() === 'cart';
  }

  /* Session-scoped so a sync that can never succeed (an unavailable card variant,
     say) degrades to a stale count instead of an endless reload. */
  function reloadBudgetLeft() {
    try {
      return parseInt(sessionStorage.getItem(FIX_ATTEMPTS_KEY) || '0', 10) < 2;
    } catch (_) {
      return false;
    }
  }

  function noteReload() {
    try {
      var n = parseInt(sessionStorage.getItem(FIX_ATTEMPTS_KEY) || '0', 10);
      sessionStorage.setItem(FIX_ATTEMPTS_KEY, String(n + 1));
    } catch (_) { /* private mode — just skip the guard */ }
  }

  function clearReloadBudget() {
    try { sessionStorage.removeItem(FIX_ATTEMPTS_KEY); } catch (_) {}
  }

  /* Brings the card line in line with the belt count. Reloads only when the
     correction has to be visible, i.e. on the cart page. */
  function repairCard(allowReload) {
    return syncPrivilegeCard()
      .then(function (changed) {
        if (!changed) { clearReloadBudget(); return false; }
        if (!allowReload || !onCartPage() || !reloadBudgetLeft()) return false;
        noteReload();
        window.location.reload();
        return true;
      })
      .catch(function (e) {
        console.warn('[MotifinoBelt] Privilege card sync failed:', e);
        return false;
      });
  }

  /* Observe cart writes made by the rest of the theme. */
  if (typeof window.fetch === 'function' && !window.fetch.__motifinoPatched) {
    var nativeFetch = window.fetch.bind(window);

    var patched = function (input, init) {
      var result = nativeFetch(input, init);

      try {
        var url = requestUrl(input);
        if (
          CART_WRITE.test(url) &&
          requestMethod(input, init) === 'POST' &&
          !isOurRequest(input, init)
        ) {
          return result.then(function (response) {
            if (response.ok) {
              /* Detached from the theme's own promise chain: a sync failure must
                 never break the add-to-cart the customer just made. */
              repairCard(true);
            }
            return response;
          });
        }
      } catch (_) { /* never let the observer break a request */ }

      return result;
    };

    patched.__motifinoPatched = true;
    window.fetch = patched;
  }

  /* Self-heal on load — catches full page navigations, the back button, and any
     add that happened while this script was not on the page. */
  function initAutoRepair() {
    if (!onCartPage()) { clearReloadBudget(); return; }
    if (window.MOTIFINO_CART_PAGE_HANDLES_SYNC) return;
    repairCard(true);
  }

  /* ── Public API ─────────────────────────────────────────── */
  window.MotifinoBelt = {
    COMBINATION_TYPE: COMBINATION_TYPE,
    PRIVILEGE_CARD_HANDLE: PRIVILEGE_CARD_HANDLE,
    STRAP_SLUG: STRAP_SLUG,
    BUCKLE_SLUG: BUCKLE_SLUG,
    handleFor: handleFor,
    optionValueForLength: optionValueForLength,
    lengthDigits: lengthDigits,
    resolveCombination: resolveCombination,
    privilegeCardVariantId: privilegeCardVariantId,
    prefetchCombination: prefetchCombination,
    renderSections: renderSections,
    getCart: getCart,
    isBeltItem: isBeltItem,
    isPrivilegeCardItem: isPrivilegeCardItem,
    countBelts: countBelts,
    syncPrivilegeCard: syncPrivilegeCard,
    addBelt: addBelt,
    addBelts: addBelts,
    repairCard: repairCard,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAutoRepair);
  } else {
    initAutoRepair();
  }
})();
