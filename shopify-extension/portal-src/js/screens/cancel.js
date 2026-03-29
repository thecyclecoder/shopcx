// portal-src/screens/cancel.js
// Cancel flow as a "screen" (not a modal).
//
// Entry URL:
//   /pages/portal/subscription?id=<contractId>&intent=cancel
//
// Requirements:
// - Customer can exit at all times (Back to subscription details).
// - No fresh contract fetch: use cached/in-memory contract already loaded.
// - Decision tree screens: reason -> offer -> confirm
// - Offers call actions (pause/frequency/coupon/etc.)
// - Images: read from DOM data attr (Liquid schema later). Safe fallback if missing.
// - Coupons: read from DOM data attr (Liquid schema later). Safe fallback if missing.

(function () {
  window.__SP = window.__SP || {};
  window.__SP.screens = window.__SP.screens || {};

  // ---------------- helpers ----------------

  function safeStr(v) {
    return typeof v === 'string' ? v : v == null ? '' : String(v);
  }

  // ---------------- analytics ----------------

  function getAnalytics() {
    return (window.__SP && window.__SP.analytics) || null;
  }

  var CANCEL_ENTER_FLAG_PREFIX = '__sp_cancel_enter_v1:'; // + contractId
  var CANCEL_STEP_FLAG_PREFIX = '__sp_cancel_step_v1:'; // + contractId + ':' + step
  var CANCEL_REASON_FLAG_PREFIX = '__sp_cancel_reason_v1:'; // + contractId + ':' + reason

  function fireCancelEnterOnce(contractId) {
    try {
      if (typeof sessionStorage === 'undefined') return;
      var cid = safeStr(contractId).trim();
      if (!cid) return;

      var key = CANCEL_ENTER_FLAG_PREFIX + cid;
      if (sessionStorage.getItem(key) === '1') return;

      var a = getAnalytics();
      if (!a || typeof a.send !== 'function') return;

      // "entered cancel flow"
      a.send('portal_cancel_started', {
        action: 'cancel_start',
      });

      sessionStorage.setItem(key, '1');
    } catch (e) {}
  }

  function fireCancelStepOnce(contractId, step, reason) {
    try {
      if (typeof sessionStorage === 'undefined') return;

      var cid = safeStr(contractId).trim();
      var st = safeStr(step).trim().toLowerCase();
      if (!cid || !st) return;

      var key = CANCEL_STEP_FLAG_PREFIX + cid + ':' + st;
      if (sessionStorage.getItem(key) === '1') return;

      var a = getAnalytics();
      if (!a || typeof a.send !== 'function') return;

      // track step view
      a.send('portal_cancel_step_view', {
        action: 'cancel_step_' + st, // uses your existing "portal_Action" dimension param=action
        reason: safeStr(reason || ''),
      });

      sessionStorage.setItem(key, '1');
    } catch (e) {}
  }

  function fireCancelReasonSelectedOnce(contractId, reason) {
    try {
      if (typeof sessionStorage === 'undefined') return;

      var cid = safeStr(contractId).trim();
      var r = safeStr(reason).trim();
      if (!cid || !r) return;

      var key = CANCEL_REASON_FLAG_PREFIX + cid + ':' + r;
      if (sessionStorage.getItem(key) === '1') return;

      var a = getAnalytics();
      if (!a || typeof a.send !== 'function') return;

      a.send('portal_cancel_reason_selected', {
        action: 'cancel_reason_selected',
        reason: r,
      });

      sessionStorage.setItem(key, '1');
    } catch (e) {}
  }
  function fireCancelSavedOnce(contractId, offerType, reason) {
    try {
      if (typeof sessionStorage === 'undefined') return;

      var cid = safeStr(contractId).trim();
      var ot = safeStr(offerType).trim();
      if (!cid || !ot) return;

      var key = '__sp_cancel_saved_v1:' + cid + ':' + ot;
      if (sessionStorage.getItem(key) === '1') return;

      var a = getAnalytics();
      if (!a || typeof a.send !== 'function') return;

      a.send('portal_cancel_saved', {
        action: 'cancel_saved',
        offer_type: ot,
        reason: safeStr(reason || ''),
      });

      sessionStorage.setItem(key, '1');
    } catch (e) {}
  }

  function fireCancelCompletedOnce(contractId, reason) {
    try {
      if (typeof sessionStorage === 'undefined') return;

      var cid = safeStr(contractId).trim();
      if (!cid) return;

      var key = '__sp_cancel_completed_v1:' + cid;
      if (sessionStorage.getItem(key) === '1') return;

      var a = getAnalytics();
      if (!a || typeof a.send !== 'function') return;

      a.send('portal_cancel_completed', {
        action: 'cancel_completed',
        reason: safeStr(reason || ''),
      });

      sessionStorage.setItem(key, '1');
    } catch (e) {}
  }

  function qs() {
    try {
      return new URLSearchParams(window.location.search || '');
    } catch (e) {
      return new URLSearchParams();
    }
  }

  function getContractIdFromUrl() {
    var sp = qs();
    return safeStr(sp.get('id') || sp.get('contractId') || '');
  }

  function buildDetailUrl(contractId) {
    var path = safeStr(window.location.pathname || '');
    return path + '?id=' + encodeURIComponent(String(contractId || ''));
  }

  function pushSearch(paramsObj) {
    // Keep pathname same, update query.
    var path = safeStr(window.location.pathname || '');
    var sp = new URLSearchParams(window.location.search || '');

    Object.keys(paramsObj || {}).forEach(function (k) {
      var val = paramsObj[k];
      if (val == null || val === '') sp.delete(k);
      else sp.set(k, String(val));
    });

    var href = path + '?' + sp.toString();
    try {
      window.history.pushState({}, '', href);
    } catch (e) {
      window.location.href = href;
      return;
    }

    // Router may re-render; we also render directly for speed.
    try {
      window.__SP.screens.cancel.render();
      scrollToCancelTop();
    } catch (e2) {}
  }

  function exitToDetail(ui, contractId) {
    var href = buildDetailUrl(contractId);

    // Update URL without refresh
    try {
      window.history.pushState({}, '', href);
    } catch (e) {
      // worst-case fallback (avoid if possible)
      try {
        window.location.href = href;
      } catch (_) {}
      return;
    }

    // Render detail screen directly (no page load)
    try {
      if (
        window.__SP &&
        window.__SP.screens &&
        window.__SP.screens.subscriptionDetail &&
        typeof window.__SP.screens.subscriptionDetail.render === 'function'
      ) {
        window.__SP.screens.subscriptionDetail.render();
        return;
      }
    } catch (e2) {}

    // If detail screen isn't available, router can handle it
    try {
      window.__SP.router && window.__SP.router.start && window.__SP.router.start();
    } catch (e3) {}
  }

  function showToast(ui, msg, type) {
    try {
      var busy = window.__SP.actions && window.__SP.actions.busy;
      if (busy && typeof busy.showToast === 'function') {
        busy.showToast(ui, msg, type || 'success');
        return;
      }
    } catch (e) {}
    try {
      console.log('[toast]', type || 'info', msg);
    } catch (e2) {}
  }

  function parseJsonAttribute(raw) {
    try {
      if (!raw) return null;
      // tolerate HTML entity encoding
      var s = String(raw)
        .replace(/&quot;/g, '"')
        .replace(/&#34;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
      return JSON.parse(s);
    } catch (e) {
      return null;
    }
  }

  function getCatalogFromDom() {
    // Catalog is attached to root div data-products-available-to-add='[...]'
    // We grab the first occurrence on the page.
    try {
      var el =
        document.querySelector('[data-products-available-to-add]') ||
        document.querySelector('[data-products-available-to-add-json]') ||
        null;
      if (!el) return [];
      var raw =
        el.getAttribute('data-products-available-to-add') ||
        el.getAttribute('data-products-available-to-add-json') ||
        '';
      var parsed = parseJsonAttribute(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e2) {
      return [];
    }
  }

  function isShippingProtectionLine(line) {
    var title = safeStr(line && line.title).toLowerCase();
    var sku = safeStr(line && line.sku).toLowerCase();
    if (title.indexOf('shipping protection') !== -1) return true;
    if (sku.indexOf('shipping') !== -1 && sku.indexOf('protect') !== -1) return true;
    return false;
  }

  function shortId(gidOrId) {
    var s = safeStr(gidOrId).trim();
    if (!s) return '';
    var parts = s.split('/');
    return (parts[parts.length - 1] || s).trim();
  }

  function normalizeProductId(input) {
    // Accept "123", 123, "gid://shopify/Product/123"
    var sid = shortId(input);
    if (!sid) return '';
    var digits = sid.replace(/[^\d]/g, '');
    return (digits || sid).trim();
  }

  function uniqKeepOrder(arr) {
    var seen = {};
    var out = [];
    for (var i = 0; i < (arr || []).length; i++) {
      var v = safeStr(arr[i]).trim();
      if (!v) continue;
      if (seen[v]) continue;
      seen[v] = 1;
      out.push(v);
    }
    return out;
  }

  function getContractLines(contract) {
    // supports either {lines:[...]} or {lines:{nodes:[...]}}
    var nodes =
      contract && contract.lines && Array.isArray(contract.lines)
        ? contract.lines
        : contract && contract.lines && Array.isArray(contract.lines.nodes)
          ? contract.lines.nodes
          : [];
    return nodes || [];
  }

  function getRealProductIds(contract) {
    var nodes = getContractLines(contract);
    var ids = [];
    for (var i = 0; i < nodes.length; i++) {
      var ln = nodes[i];
      if (!ln) continue;
      if (isShippingProtectionLine(ln)) continue;
      var pid = normalizeProductId(ln.productId || ln.product_id || '');
      if (pid) ids.push(pid);
    }
    return uniqKeepOrder(ids);
  }

  function getFirstRealLine(contract) {
    var nodes = getContractLines(contract);
    for (var i = 0; i < nodes.length; i++) {
      var ln = nodes[i];
      if (!ln) continue;
      if (!safeStr(ln.variantId)) continue; // must have a variant to swap
      if (isShippingProtectionLine(ln)) continue;
      return ln;
    }
    return null;
  }

  function scrollToCancelTop() {
    try {
      var wrapper = document.querySelector('.sp-cancel');
      if (!wrapper) return;

      var rect = wrapper.getBoundingClientRect();
      var absoluteTop = rect.top + window.pageYOffset;

      var offset = 150; // extra space for fixed header etc.
      window.scrollTo({
        top: absoluteTop - offset,
        behavior: 'smooth',
      });
    } catch (e) {}
  }

  function getCachedContractById(contractId) {
    // Best effort: use whatever is already in memory first
    try {
      var st = window.__SP.state || {};
      var c = st.currentContract || st.contract || null;
      if (c && safeStr(c.id) && String(c.id).indexOf(String(contractId)) !== -1) return c;
      if (c && safeStr(c.id) && safeStr(contractId) && safeStr(c.id).endsWith('/' + contractId))
        return c;
    } catch (e) {}

    // Fall back to session cache
    try {
      var raw = sessionStorage.getItem('__sp_subscriptions_cache_v2');
      if (!raw) return null;
      var entry = JSON.parse(raw);
      var list =
        entry && entry.data && Array.isArray(entry.data.contracts) ? entry.data.contracts : [];
      for (var i = 0; i < list.length; i++) {
        var c2 = list[i];
        if (!c2 || !c2.id) continue;
        if (String(c2.id).endsWith('/' + String(contractId))) return c2;
        if (String(c2.id) === String(contractId)) return c2;
      }
    } catch (e2) {}

    return null;
  }

  function parseJsonAttribute(str) {
    var s = safeStr(str).trim();
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch (e) {
      return null;
    }
  }

  function getCancelImagesFromDom() {
    try {
      var el = document.querySelector('[data-cancel-images-json]') || null;
      if (!el) return {};
      var raw = el.getAttribute('data-cancel-images-json') || '';
      var parsed = parseJsonAttribute(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function getCancelCouponsFromDom() {
    // Expect JSON like: { "10":"CODE10", "15":"CODE15", "20":"CODE20", "25":"CODE25" }
    // Flexible keys: "p20" also allowed.
    try {
      var el = document.querySelector('[data-cancel-coupons-json]') || null;
      if (!el) return {};
      var raw = el.getAttribute('data-cancel-coupons-json') || '';
      var parsed = parseJsonAttribute(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function couponCodeForPct(coupons, pct) {
    pct = Number(pct);
    if (!isFinite(pct) || pct <= 0) return '';

    // Try numeric string keys first: "20"
    var k1 = String(Math.round(pct));
    var v = safeStr(coupons && coupons[k1]);
    if (v) return v;

    // Try "p20"
    var k2 = 'p' + k1;
    v = safeStr(coupons && coupons[k2]);
    if (v) return v;

    // ✅ Try "pct20" (your Liquid schema format)
    var k2b = 'pct' + k1;
    v = safeStr(coupons && coupons[k2b]);
    if (v) return v;

    // Try direct "20%"
    var k3 = k1 + '%';
    v = safeStr(coupons && coupons[k3]);
    if (v) return v;

    return '';
  }

  function reasonConfig(images, coupons) {
    return {
      reached_goals: {
        title: 'I already reached my goals',
        offerTitle: 'Keep your results without overstocking',
        empath:
          'That’s a win. Maintenance is how you keep it. Most members switch to every 2 months so they stay consistent while keeping subscriber pricing locked in.',
        primaryHint: 'Maintenance mode',
        secondaryHint: 'Skip 60 days, keep perks',
        primary: { type: 'frequency', months: 2, label: 'Switch to every 2 months' },
        secondary: { type: 'pause', days: 60, label: 'Pause 60 days' },
        image: safeStr(images.reached_goals || images.maintenance || ''),
      },
      too_much_product: {
        title: 'I have too much product',
        offerTitle: 'Let’s right-size your deliveries',
        empath:
          'Totally fair. Stock can build up fast. Before you cancel, choose a quick fix below. You’ll keep subscriber pricing and priority access. We reserve limited inventory for active subscribers, so staying active helps you lock in your spot.',
        primaryHint: '80% of customers choose this',
        secondaryHint: 'Locks in subscriber perks',
        primary: { type: 'pause', days: 60, label: 'Pause 60 days' },
        secondary: { type: 'frequency', months: 2, label: 'Switch to every 2 months' },
        image: safeStr(images.too_much_product || images.too_much || ''),
      },

      too_expensive: {
        title: 'It’s too expensive',
        offerTitle: 'Your loyalty unlocks a discount right now',
        empath:
          'We get it. Costs add up. Before you cancel, claim a loyalty discount or space out your deliveries so you keep subscriber perks. If you cancel, your current pricing and priority access may not be available when you come back.',
        primaryHint: 'Most members choose this',
        secondaryHint: 'Protects your current pricing',
        primary: {
          type: 'coupon',
          pct: 20,
          label: 'Get 20% off next order',
          discountCode: couponCodeForPct(coupons, 20),
        },
        secondary: { type: 'frequency', months: 2, label: 'Switch to every 2 months' },
        image: safeStr(images.too_expensive || ''),
      },

      not_getting_results: {
        title: 'I’m not getting results',
        offerTitle: 'Give it one more cycle with extra savings',
        empath:
          'You deserve to feel a difference. Most benefits build with consistent use. Before you cancel, grab a bigger discount for your next order or pause briefly. Cancelling can make it harder to restart at the same pricing later.',
        primaryHint: 'Best savings option',
        secondaryHint: 'Gives you breathing room',
        primary: {
          type: 'coupon',
          pct: 25,
          label: 'Get 25% off next order',
          discountCode: couponCodeForPct(coupons, 25),
        },
        secondary: { type: 'pause', days: 30, label: 'Pause 30 days' },
        image: safeStr(images.not_getting_results || images.no_results || ''),
      },

      tired_of_flavor: {
        title: 'I’m tired of the flavors',
        offerTitle: 'Refresh your routine',
        empath:
          'Flavor fatigue is real. The good news is you don’t need to cancel. Swap flavors or remove an item in seconds and keep subscriber perks active.',
        primaryHint: 'Most customers swap instead',
        secondaryHint: 'Short break, same perks',
        primary: { type: 'manage_items', label: 'Swap or remove items' },
        secondary: { type: 'pause', days: 30, label: 'Pause 30 days' },
        image: safeStr(images.tired_of_flavor || images.flavor || ''),
      },

      shipping_issues: {
        title: 'Shipping or delivery issues',
        offerTitle: 'Let’s fix this fast',
        empath:
          'Delivery problems are frustrating. Before you cancel, pause briefly so we can make it right and you keep subscriber perks. Cancelling doesn’t solve shipping. Fixing it does.',
        primaryHint: 'Quickest fix',
        secondaryHint: 'Get help from support',
        primary: { type: 'pause', days: 30, label: 'Pause 30 days' },
        secondary: { type: 'support', label: 'Contact support' },
        image: safeStr(images.shipping_issues || images.shipping || ''),
      },
    };
  }

  // ---------------- reviews (cancel reason step) ----------------

  function getReviewsStore() {
    try {
      return window.__SP && window.__SP.data && window.__SP.data.reviews;
    } catch (e) {
      return null;
    }
  }

  function hasAnyReviews(store, productIds) {
    if (!store || typeof store.hasReviews !== 'function') return false;
    for (var i = 0; i < (productIds || []).length; i++) {
      if (store.hasReviews(productIds[i])) return true;
    }
    return false;
  }

  function ensureCancelReviewsPrefetch(contractId, productIds) {
    // One-shot per contract id to avoid repeated .then(render) loops
    window.__SP._cancelReviewsPrefetch = window.__SP._cancelReviewsPrefetch || {};
    var key = safeStr(contractId || '');
    if (!key) return;

    var store = getReviewsStore();
    if (!store || typeof store.fetchFeatured !== 'function') return;

    if (window.__SP._cancelReviewsPrefetch[key]) return;
    window.__SP._cancelReviewsPrefetch[key] = 1;

    try {
      store
        .fetchFeatured(productIds)
        .then(function () {
          // If user is still on cancel reason step, re-render so the right column can appear
          try {
            var sp = qs();
            var step = safeStr(sp.get('step') || 'reason').toLowerCase();
            var stillCancel = safeStr(sp.get('intent') || 'cancel').toLowerCase() === 'cancel';
            var curId = getContractIdFromUrl();
            if (stillCancel && step === 'reason' && safeStr(curId) === key) {
              window.__SP.screens.cancel.render();
            }
          } catch (e2) {}
        })
        .catch(function () {
          // ignore (reviews card simply won't render)
        });
    } catch (e) {}
  }

  // ---------------- UI builders ----------------

  function header(ui, contractId, titleText) {
    var detailUrl = buildDetailUrl(contractId);

    return ui.el('div', { class: 'sp-cancel__header' }, [
      ui.el('a', { class: 'sp-btn sp-btn--ghost sp-cancel__back', href: detailUrl }, [
        '← Back to subscription',
      ]),
      ui.el('div', { class: 'sp-cancel__title sp-title2' }, [titleText || 'Cancel subscription']),
    ]);
  }

  function reasonTile(ui, key, label, selectedKey, onClick) {
    var isSel = key === selectedKey;
    var cls = 'sp-btn sp-btn--ghost sp-itemopt sp-itemopt--left' + (isSel ? ' is-selected' : '');
    var btn = ui.el('button', { type: 'button', class: cls }, [
      ui.el('div', { class: 'sp-itemopt__title' }, [label]),
      ui.el('div', { class: 'sp-itemopt__desc sp-muted' }, ['Tap to select']),
    ]);
    btn.addEventListener('click', onClick);
    return btn;
  }

  function buildReasonsList(ui, cfg, selectedKey) {
    var keys = Object.keys(cfg);
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      (function (k) {
        out.push(
          reasonTile(ui, k, cfg[k].title, selectedKey, function () {
            pushSearch({ reason: k, step: 'offer' });
          })
        );
      })(keys[i]);
    }
    return out;
  }

  function buildReviewsCard(ui, contract, productIds) {
    try {
      var cards = window.__SP && window.__SP.cards;
      var reviewsCard = cards && cards.reviews;
      if (!reviewsCard || typeof reviewsCard.render !== 'function') return null;

      var r = reviewsCard.render(ui, { contract: contract, productIds: productIds });
      if (!r || !r.el) return null;
      return r.el;
    } catch (e) {
      return null;
    }
  }

  function renderReasonStep(ui, contractId, contract, cfg, selectedKey) {
    var productIds = getRealProductIds(contract);
    var store = getReviewsStore();

    // Kick off prefetch (cached/localStorage will short-circuit)
    ensureCancelReviewsPrefetch(contractId, productIds);

    // Decide whether we should render 2-col layout now (based on already-cached reviews)
    var showSideReviews = hasAnyReviews(store, productIds);
    var reasonsClass = showSideReviews
      ? 'sp-detail__actions sp-detail__actions--stack sp-cancel__reasons sp-cancel__reasons--onecol'
      : 'sp-detail__actions sp-detail__actions--stack sp-cancel__reasons sp-cancel__reasons--twocol';

    var reasonsEl = ui.el('div', { class: reasonsClass }, buildReasonsList(ui, cfg, selectedKey));

    var alertBar = ui.el('div', { class: 'sp-cancel__alert sp-cancel__alert--top' }, [
      ui.el('div', { class: 'sp-cancel__alert-title' }, ['Not cancelled yet']),
      ui.el('div', { class: 'sp-cancel__alert-sub' }, [
        'Your subscription remains active until you confirm on the final step.',
      ]),
    ]);

    var intro = ui.el('div', { class: 'sp-cancel__required' }, [
      ui.el('div', { class: 'sp-cancel__required-title' }, ['To complete your cancellation']),
      ui.el('div', { class: 'sp-cancel__required-sub sp-muted' }, [
        'Select the option that best describes your reason for cancelling.',
      ]),
    ]);

    var footer = ui.el('div', { class: 'sp-cancel__footer' }, [
      ui.el('a', { class: 'sp-cancel__exit sp-muted', href: buildDetailUrl(contractId) }, [
        'Back to subscription details',
      ]),
    ]);

    // Base card shell
    var card = ui.el('div', { class: 'sp-card sp-detail__card sp-cancel' }, [
      header(ui, contractId, 'Cancel subscription'),
    ]);

    card.appendChild(alertBar);

    // Reasons panel container
    var reasonsPanel = ui.el('div', { class: 'sp-cancel__reasons-panel' }, []);

    if (!showSideReviews) {
      // No reviews -> keep reasons full width (2 columns)
      reasonsPanel.appendChild(intro);
      reasonsPanel.appendChild(reasonsEl);
      reasonsPanel.appendChild(footer);
      card.appendChild(reasonsPanel);
      return card;
    }

    // Reviews exist -> two column layout
    var layout = ui.el('div', { class: 'sp-cancel__layout' }, []);
    var left = ui.el('div', { class: 'sp-cancel__left' }, []);
    var right = ui.el('div', { class: 'sp-cancel__right' }, []);

    left.appendChild(intro);
    left.appendChild(reasonsEl);
    left.appendChild(footer);

    var reviewsEl = buildReviewsCard(ui, contract, productIds);
    if (reviewsEl) right.appendChild(reviewsEl);

    layout.appendChild(left);

    // Only append right if we actually got a card element
    if (right.childNodes && right.childNodes.length) layout.appendChild(right);

    reasonsPanel.appendChild(layout);
    card.appendChild(reasonsPanel);
    return card;
  }

  function offerCard(ui, conf) {
    var img = safeStr(conf.image || '');
    var hasImg = !!img;

    return ui.el('div', { class: 'sp-cancel-offer__grid sp-wrap' }, [
      hasImg
        ? ui.el('img', { class: 'sp-cancel-offer__img', src: img, alt: safeStr(conf.title) }, [])
        : ui.el('span', { class: 'sp-cancel-offer__imgplaceholder' }, []),

      ui.el('div', { class: 'sp-cancel-offer__copy' }, [
        ui.el('div', { class: 'sp-note sp-cancel-offer__note' }, [
          ui.el('div', { class: 'sp-note__title' }, [safeStr(conf.offerTitle || 'We hear you.')]),
          ui.el('div', { class: 'sp-note__body' }, [safeStr(conf.empath || '')]),
        ]),
      ]),
    ]);
  }

  function renderOfferStep(ui, contractId, cfg, reasonKey) {
    var conf = cfg[reasonKey] || null;
    if (!conf) {
      pushSearch({ step: 'reason', reason: '' });
      return ui.el('span', {}, []);
    }

    var primaryHint = safeStr(conf.primaryHint || 'Most customers choose this');
    var secondaryHint = safeStr(conf.secondaryHint || 'Protects your current pricing');

    var card = ui.el('div', { class: 'sp-card sp-detail__card sp-cancel sp-cancel-offer' }, [
      header(ui, contractId, 'Let’s fix this'),

      ui.el('div', { class: 'sp-cancel__alert sp-cancel__alert--offer' }, [
        ui.el('div', { class: 'sp-cancel__alert-title' }, ['Not cancelled yet']),
        ui.el('div', { class: 'sp-cancel__alert-sub' }, [
          'Your subscription remains active until you confirm on the final step.',
        ]),
      ]),

      offerCard(ui, conf),

      ui.el('div', { class: 'sp-cancel-offer__actions-panel' }, [
        ui.el('div', { class: 'sp-cancel-offer__actions-grid' }, [
          ui.el('div', { class: 'sp-cancel-offer__action' }, [
            ui.el(
              'button',
              { type: 'button', class: 'sp-btn sp-btn-primary sp-cancel-offer__btn' },
              [safeStr(conf.primary && conf.primary.label) || 'Continue']
            ),
            ui.el('div', { class: 'sp-cancel-offer__hint sp-muted' }, [primaryHint]),
          ]),

          ui.el('div', { class: 'sp-cancel-offer__action' }, [
            ui.el(
              'button',
              { type: 'button', class: 'sp-btn sp-btn--ghost sp-cancel-offer__btn' },
              [safeStr(conf.secondary && conf.secondary.label) || 'Another option']
            ),
            ui.el('div', { class: 'sp-cancel-offer__hint sp-muted' }, [secondaryHint]),
          ]),
        ]),

        ui.el(
          'button',
          { type: 'button', class: 'sp-btn sp-btn--ghost sp-cancel-offer__cancelbtn' },
          ['Continue to cancel']
        ),
      ]),
    ]);

    var btns = card.querySelectorAll('button');

    btns[0].addEventListener('click', function () {
      runOffer(ui, contractId, conf.primary, reasonKey);
    });

    btns[1].addEventListener('click', function () {
      runOffer(ui, contractId, conf.secondary, reasonKey);
    });

    btns[2].addEventListener('click', function () {
      try {
        scrollToCancelTop();
      } catch (e) {}
      pushSearch({ step: 'confirm' });
    });

    return card;
  }

  function renderConfirmStep(ui, contractId /*, reasonKey*/) {
    var contract = getCachedContractById(contractId);

    var productIds = contract ? getRealProductIds(contract) : [];
    var store = getReviewsStore();

    // Prefetch (cached/localStorage will short-circuit)
    ensureCancelReviewsPrefetch(contractId, productIds);

    var showSideReviews = hasAnyReviews(store, productIds);

    var card = ui.el('div', { class: 'sp-card sp-detail__card sp-cancel sp-cancel-confirm' }, [
      header(ui, contractId, 'Confirm cancellation'),
    ]);

    var leftInner = ui.el('div', { class: 'sp-cancel-confirm__leftinner' }, [
      ui.el('p', { class: 'sp-muted sp-cancel-confirm__copy' }, [
        'You can come back any time. If you’d still like to cancel, confirm below.',
      ]),
      ui.el(
        'div',
        { class: 'sp-detail__actions sp-detail__actions--stack sp-cancel-confirm__actions' },
        [
          ui.el('button', { type: 'button', class: 'sp-btn sp-btn-primary' }, [
            'Cancel subscription',
          ]),
          ui.el('button', { type: 'button', class: 'sp-btn sp-btn--ghost' }, ['Keep subscription']),
        ]
      ),
    ]);

    if (!showSideReviews) {
      // Original full-width layout
      card.appendChild(leftInner);
    } else {
      // Two-column layout (left actions + right reviews)
      var layout = ui.el('div', { class: 'sp-cancel__layout sp-cancel-confirm__layout' }, []);
      var left = ui.el('div', { class: 'sp-cancel__left sp-cancel-confirm__left' }, []);
      var right = ui.el('div', { class: 'sp-cancel__right sp-cancel-confirm__right' }, []);

      left.appendChild(leftInner);

      var reviewsEl = buildReviewsCard(ui, contract, productIds);
      if (reviewsEl) right.appendChild(reviewsEl);

      layout.appendChild(left);
      if (right.childNodes && right.childNodes.length) layout.appendChild(right);

      card.appendChild(layout);
    }

    // Wire buttons
    var btns = card.querySelectorAll('button');
    btns[0].addEventListener('click', async function () {
      try {
        try {
          scrollToCancelTop();
        } catch (e) {}

        var contractGid = findContractGidFromCancel(contractId);
        if (!contractGid) {
          showToast(ui, 'Missing subscription ID. Please try again.', 'error');
          return;
        }

        var actions = window.__SP && window.__SP.actions;
        if (!actions || typeof actions.cancel !== 'function') {
          showToast(ui, 'Cancel action not available. Please try again.', 'error');
          return;
        }

        var r = await actions.cancel(ui, contractGid);
        if (r && r.ok === false) return;

        // pull reason from URL (confirm step still has ?reason=...)
        var sp2 = qs();
        var reason2 = safeStr(sp2.get('reason') || '');

        fireCancelCompletedOnce(contractId, reason2);

        exitToDetail(ui, contractId);
      } catch (err) {
        try {
          console.warn('[cancel] hard cancel failed', err);
        } catch (_) {}
        showToast(ui, 'Sorry — we couldn’t cancel your subscription. Please try again.', 'error');
      }
    });

    btns[1].addEventListener('click', function () {
      exitToDetail(ui, contractId);
    });

    return card;
  }

  function openSwapFirstItemModal(ui, actions, contract) {
    try {
      var modal = window.__SP && window.__SP.modals && window.__SP.modals.addSwap;
      if (!modal || typeof modal.open !== 'function') {
        showToast(ui, 'Swap is not available right now.', 'error');
        return;
      }

      if (!actions || !actions.items) {
        showToast(ui, 'Actions not available.', 'error');
        return;
      }

      var line = getFirstRealLine(contract);
      if (!line) {
        showToast(ui, 'No swappable items found on this subscription.', 'error');
        return;
      }

      // ✅ Catalog from DOM
      var catalog = getCatalogFromDom();
      if (!catalog.length) catalog = [];

      function getLineSnapshot() {
        var nodes = getContractLines(contract);
        var snap = [];
        for (var i = 0; i < nodes.length; i++) {
          var ln = nodes[i];
          if (!ln) continue;

          var isReal = !isShippingProtectionLine(ln);
          snap.push({
            id: safeStr(ln.id),
            variantId: safeStr(ln.variantId),
            quantity: Number(ln.quantity) || 1,
            isReal: isReal,
          });
        }
        return snap;
      }

      modal.open(ui, {
        mode: 'swap',
        contractId: safeStr(contract && contract.id),
        line: line,
        catalog: catalog,
        getLineSnapshot: getLineSnapshot,

        onSubmit: function (payload) {
          if (typeof actions.items.submitAddSwap === 'function') {
            return actions.items.submitAddSwap(ui, payload);
          }
          if (typeof actions.items.applyAddSwap === 'function') {
            return actions.items.applyAddSwap(ui, payload);
          }
          throw new Error('Swap action not wired.');
        },
      });
    } catch (e) {
      showToast(ui, (e && e.message) || 'Could not open swap.', 'error');
    }
  }

  // ---------------- action wiring ----------------

  function findContractGidFromCancel(contractId) {
    var c = getCachedContractById(contractId);
    return c && c.id ? String(c.id) : '';
  }

  async function runOffer(ui, contractId, offer, reasonKey) {
    offer = offer || {};
    var type = safeStr(offer.type || '');

    try {
      scrollToCancelTop();
    } catch (e) {}

    var contractGid = findContractGidFromCancel(contractId);
    if (!contractGid) {
      showToast(ui, 'Missing subscription ID. Please try again.', 'error');
      return;
    }

    var actions = window.__SP && window.__SP.actions;
    if (!actions) {
      showToast(ui, 'Actions not available. Please try again.', 'error');
      return;
    }

    try {
      if (type === 'pause') {
        var days = Number(offer.days);
        if (!isFinite(days) || days <= 0) throw new Error('invalid_pause_days');
        if (typeof actions.pause !== 'function') throw new Error('pause_action_missing');

        var r1 = await actions.pause(ui, contractGid, days);
        if (r1 && r1.ok === false) return;

        exitToDetail(ui, contractId);
        fireCancelSavedOnce(contractId, 'pause', reasonKey);
        return;
      }

      if (type === 'frequency') {
        var months = Number(offer.months);
        if (!isFinite(months) || months <= 0) throw new Error('invalid_frequency_months');
        if (!actions.frequency || typeof actions.frequency.update !== 'function')
          throw new Error('frequency_action_missing');

        var r2 = await actions.frequency.update(ui, contractGid, {
          intervalCount: months,
          interval: 'MONTH',
        });
        if (r2 && r2.ok === false) return;
        fireCancelSavedOnce(contractId, 'frequency', reasonKey);
        exitToDetail(ui, contractId);
        return;
      }

      if (type === 'coupon') {
        if (!actions.coupon) throw new Error('coupon_action_missing');

        var code =
          safeStr(offer.discountCode || offer.code || '') ||
          (function () {
            var coupons = getCancelCouponsFromDom();
            return couponCodeForPct(coupons, offer.pct);
          })();

        if (!code) {
          showToast(ui, 'Coupon not configured yet.', 'error');
          return;
        }

        if (typeof actions.coupon.apply === 'function') {
          var r3 = await actions.coupon.apply(ui, contractGid, code);
          if (r3 && r3.ok === false) return;
          fireCancelSavedOnce(contractId, 'coupon', reasonKey);
          exitToDetail(ui, contractId);
          return;
        }

        if (typeof actions.coupon.run === 'function') {
          var r4 = await actions.coupon.run(ui, {
            mode: 'apply',
            contractId: contractGid,
            discountCode: code,
          });
          if (r4 && r4.ok === false) return;
          fireCancelSavedOnce(contractId, 'coupon', reasonKey);
          exitToDetail(ui, contractId);
          return;
        }

        throw new Error('coupon_apply_missing');
      }

      if (type === 'manage_items') {
        try {
          var contract = getCachedContractById(contractId);

          if (!contract) {
            showToast(
              ui,
              'We could not load your subscription. Please refresh and try again.',
              'error'
            );
            return;
          }

          if (!actions || !window.__SP || !window.__SP.modals || !window.__SP.modals.addSwap) {
            showToast(ui, 'Swap is temporarily unavailable. Please try again.', 'error');
            return;
          }

          openSwapFirstItemModal(ui, actions, contract);
          fireCancelSavedOnce(contractId, 'manage_items', reasonKey);
        } catch (err) {
          showToast(
            ui,
            err && err.message
              ? err.message
              : 'Something went wrong opening swap. Please try again.',
            'error'
          );
        }

        return;
      }

      if (type === 'support') {
        try {
          if (window.GorgiasChat && typeof window.GorgiasChat.open === 'function') {
            window.GorgiasChat.open();
            return;
          }
          window.open('https://help.superfoodscompany.com', '_blank', 'noopener,noreferrer');
          fireCancelSavedOnce(contractId, 'support', reasonKey);
        } catch (e) {
          showToast(ui, 'Unable to open support right now. Please try again.', 'error');
        }

        return;
      }

      showToast(ui, 'This option is not available yet.', 'error');
    } catch (e2) {
      try {
        console.warn('[cancel] offer failed:', type, e2);
      } catch (_) {}
      showToast(ui, 'Sorry — we couldn’t update your subscription. Please try again.', 'error');
    }
  }

  // ---------------- screen render ----------------

  function render() {
    if (window.__SP.analytics && window.__SP.analytics.setPage) {
      window.__SP.analytics.setPage('cancel_flow');
    }
    var ui = window.__SP.ui;
    if (!ui) return;

    var contractId = getContractIdFromUrl();
    if (!contractId) {
      ui.setRoot(
        ui.card(
          "<div class='sp-wrap'><h2 class='sp-title'>Missing subscription</h2><p class='sp-muted'>No subscription id was provided.</p></div>"
        )
      );
      return;
    }

    var contract = getCachedContractById(contractId);
    if (!contract) {
      ui.setRoot(
        ui.card(
          "<div class='sp-wrap'><h2 class='sp-title'>Loading…</h2><p class='sp-muted'>Your subscription is still loading. Please try again.</p></div>"
        )
      );
      return;
    }

    var sp = qs();
    var step = safeStr(sp.get('step') || 'reason').toLowerCase();
    var reason = safeStr(sp.get('reason') || '');

    // Analytics: entered cancel flow + step + reason selected
    fireCancelEnterOnce(contractId);
    fireCancelStepOnce(contractId, step, reason);

    // Only fire "reason selected" once they actually have a reason
    if (reason) fireCancelReasonSelectedOnce(contractId, reason);

    var images = getCancelImagesFromDom();
    var coupons = getCancelCouponsFromDom();
    var cfg = reasonConfig(images, coupons);

    var rootEl;
    if (step === 'offer') rootEl = renderOfferStep(ui, contractId, cfg, reason);
    else if (step === 'confirm') rootEl = renderConfirmStep(ui, contractId, reason);
    else rootEl = renderReasonStep(ui, contractId, contract, cfg, reason);

    ui.setRoot(rootEl);

    setTimeout(function () {
      scrollToCancelTop();
    }, 50);
  }

  window.__SP.screens.cancel = { render: render };
})();
