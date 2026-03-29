// assets/portal-subscription-detail.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.screens = window.__SP.screens || {};

  // ---------------------------------------------------------------------------
  // Assumptions (no backwards compat):
  // - Subscriptions payload shape is subscriptions.ts: { ok:true, contracts:[...], buckets:{...} }
  // - Contract shape is contract-external, with portalState attached
  // - Portal-api caches subscriptions response in sessionStorage with { ts:number, data:payload }
  // - Cache key is fixed: "__sp_subscriptions_cache_v2"
  // - Cards are loaded onto window.__SP.cards.* and return { el } from .render()
  // ---------------------------------------------------------------------------

  var SUBS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes (match portal-api)
  var SUBS_CACHE_KEY = '__sp_subscriptions_cache_v2';

  function getContractIdFromUrl() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      var id = params.get('id');
      return id ? String(id).trim() : '';
    } catch (e) {
      return '';
    }
  }

  function safeStr(v) {
    return typeof v === 'string' ? v : v == null ? '' : String(v);
  }

  function getConfig() {
    var cfg = (window.__SP && window.__SP.config) || {};
    return {
      lockDays: Number(cfg.lockDays || 7),
      portalLock: !!cfg.portalLock,
    };
  }

  function toNumDate(iso) {
    var t = typeof iso === 'string' ? Date.parse(iso) : NaN;
    return isFinite(t) ? t : 0;
  }

  function daysBetween(aMs, bMs) {
    var MS_PER_DAY = 24 * 60 * 60 * 1000;
    if (!aMs || !bMs) return 0;
    return Math.floor(Math.abs(bMs - aMs) / MS_PER_DAY);
  }

  function safeGetUtils() {
    return (window.__SP && window.__SP.utils) || null;
  }

  function pill(ui, text, kind) {
    var cls = 'sp-pill sp-pill--neutral';
    if (kind === 'active') cls = 'sp-pill sp-pill--active';
    if (kind === 'cancelled') cls = 'sp-pill sp-pill--cancelled';
    if (kind === 'paused') cls = 'sp-pill sp-pill--paused';
    return ui.el('span', { class: cls }, [text]);
  }

  function renderAlert(ui, title, body) {
    return ui.el('div', { class: 'sp-alert' }, [
      ui.el('div', { class: 'sp-alert__title' }, [title]),
      ui.el('div', { class: 'sp-alert__body sp-muted' }, [body]),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Analytics helpers (subscription detail)
  // ---------------------------------------------------------------------------

  var DETAIL_VIEW_FLAG_PREFIX = '__sp_portal_sub_detail_view_v1:'; // + contractId

  function getAnalytics() {
    return (window.__SP && window.__SP.analytics) || null;
  }

  function clampInt(n, min, max) {
    var x = Number(n);
    if (!isFinite(x)) return min;
    x = Math.trunc(x);
    if (x < min) return min;
    if (x > max) return max;
    return x;
  }

  function parseDateMs(iso) {
    var s = safeStr(iso).trim();
    if (!s) return 0;
    try {
      var d = new Date(s);
      var t = d.getTime();
      return isFinite(t) ? t : 0;
    } catch (e) {
      return 0;
    }
  }

  function diffDaysCeil(fromMs, toMs) {
    if (!fromMs || !toMs) return null;
    var ms = toMs - fromMs;
    // If already past due, treat as 0
    if (ms <= 0) return 0;
    return Math.ceil(ms / (24 * 60 * 60 * 1000));
  }

  function ageBucketFromCreatedAt(createdAtIso) {
    var createdMs = parseDateMs(createdAtIso);
    if (!createdMs) return ''; // unknown
    var ageDays = Math.floor((Date.now() - createdMs) / (24 * 60 * 60 * 1000));
    if (ageDays < 0) ageDays = 0;

    if (ageDays <= 30) return '0_30';
    if (ageDays <= 60) return '30_60';
    if (ageDays <= 90) return '60_90';
    return '90_plus';
  }

  function statusForAnalytics(contract, utils) {
    // use the same bucket logic your UI uses
    try {
      if (utils && typeof utils.bucket === 'function') {
        return safeStr(utils.bucket(contract)).toLowerCase();
      }
    } catch (e) {}
    // fallback
    var raw = safeStr(contract && contract.status).toLowerCase();
    return raw || '';
  }

  function tryFireSubscriptionDetailViewOncePerSession(contract, utils) {
    try {
      if (typeof sessionStorage === 'undefined') return;

      var contractId = '';
      try {
        contractId =
          utils && typeof utils.shortId === 'function'
            ? utils.shortId(contract && contract.id)
            : safeStr(contract && contract.id);
      } catch (e) {
        contractId = safeStr(contract && contract.id);
      }
      contractId = safeStr(contractId).trim();
      if (!contractId) return;

      var key = DETAIL_VIEW_FLAG_PREFIX + contractId;
      if (sessionStorage.getItem(key) === '1') return;

      var a = getAnalytics();

      if (!a) return;

      var age_bucket = ageBucketFromCreatedAt(contract && contract.createdAt);

      // days_to_renewal (only meaningful if we have nextBillingDate and not cancelled)
      var st = statusForAnalytics(contract, utils);
      var days_to_renewal = '';
      if (st !== 'cancelled') {
        var nextMs = parseDateMs(contract && contract.nextBillingDate);
        if (nextMs) {
          var dtr = diffDaysCeil(Date.now(), nextMs);
          // Clamp to keep reporting sane
          dtr = dtr == null ? null : clampInt(dtr, 0, 365);
          if (dtr != null) days_to_renewal = dtr;
        }
      }

      if (typeof a.send === 'function') {
        a.send('portal_subscription_detail_view', {
          status: st,
          age_bucket: age_bucket,
          days_to_renewal: days_to_renewal,
        });
      } else if (typeof a.portalAction === 'function') {
        a.portalAction('subscription_detail_view', {
          status: st,
          age_bucket: age_bucket,
          days_to_renewal: days_to_renewal,
        });
      }

      sessionStorage.setItem(key, '1');
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // Cache read: fixed subscriptions cache entry in sessionStorage
  // ---------------------------------------------------------------------------

  function looksLikeSubsCacheEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (!entry.ts || typeof entry.ts !== 'number') return false;
    if (!entry.data || typeof entry.data !== 'object') return false;
    if (entry.data.ok !== true) return false;
    if (!Array.isArray(entry.data.contracts)) return false;
    return true;
  }

  function readSubscriptionsCachePayload() {
    try {
      var raw = sessionStorage.getItem(SUBS_CACHE_KEY);
      if (!raw) return null;

      var entry;
      try {
        entry = JSON.parse(raw);
      } catch (e) {
        return null;
      }

      if (!looksLikeSubsCacheEntry(entry)) return null;
      if (Date.now() - entry.ts > SUBS_CACHE_TTL_MS) return null;

      return entry.data;
    } catch (e) {
      return null;
    }
  }

  function findContractInPayload(payload, contractId, utils) {
    if (!payload || !Array.isArray(payload.contracts)) return null;

    var list = utils.pickContracts(payload);
    var want = String(contractId || '').trim();
    if (!want) return null;

    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c) continue;
      if (utils.shortId(c.id) === want) return c;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Direct fetch (ONLY when cache missing / expired)
  // ---------------------------------------------------------------------------

  async function fetchSubscriptionDetailDirect(contractId) {
    if (!window.__SP.api || typeof window.__SP.api.requestJson !== 'function') {
      throw new Error('api_not_loaded');
    }
    return await window.__SP.api.requestJson(
      'subscriptionDetail',
      { id: String(contractId || '') },
      { force: true }
    );
  }

  function normalizeDetailResponse(resp, utils) {
    if (!resp || resp.ok !== true) return null;
    var c = resp.contract || resp.data || resp.subscription || resp.appstle || null;
    if (!c || typeof c !== 'object') return null;
    return utils.normalizeContract(c);
  }

  // ---------------------------------------------------------------------------
  // Cards registry helpers
  // ---------------------------------------------------------------------------

  function getCards() {
    return (window.__SP && window.__SP.cards) || {};
  }

  function safeCardRender(cardName, ui, ctx) {
    ctx = ctx || {};
    try {
      var cards = getCards();
      var card = cards && cards[cardName];
      if (!card || typeof card.render !== 'function') return null;

      // ✅ all cards are render(ui, ctx)
      var out = card.render(ui, ctx);

      // ✅ Cards should return a DOM node (what ui.el returns)
      if (out && (out.nodeType === 1 || out.nodeType === 11)) return out;

      // Allow legacy { el: Node } just in case
      if (out && out.el && (out.el.nodeType === 1 || out.el.nodeType === 11)) return out.el;

      return null;
    } catch (e) {
      try {
        console.warn('[portal] card render failed:', cardName, e);
      } catch (_) {}
      return null;
    }
  }

  function placeholderCard(ui, title, body) {
    return ui.el('div', { class: 'sp-card sp-detail__card' }, [
      ui.el('div', { class: 'sp-detail__sectionhead' }, [
        ui.el('div', { class: 'sp-title2' }, [title]),
        ui.el('p', { class: 'sp-muted sp-detail__section-sub' }, [body || '']),
      ]),
      ui.el('p', { class: 'sp-muted sp-detail__hint' }, ['(Card not loaded)']),
    ]);
  }

  function writeDetailAsSubscriptionsCache(contract, contractId) {
    try {
      if (!contract || typeof contract !== 'object') return;

      var payload = {
        ok: true,
        route: 'subscriptions',
        setBy: 'detailPage',
        detailContractId: String(contractId || ''),

        // keep contracts shape identical (array)
        contracts: [contract],

        // optional: helps any code that expects summary to exist
        summary: {
          total_ids: 1,
          fetched_ok: 1,
          fetched_failed: 0,
          active_count: 0,
          paused_count: 0,
          cancelled_count: 0,
          other_count: 0,
          needs_attention_count: 0,
        },
      };

      // best-effort: set a minimally-correct summary bucket counts
      try {
        var utils = window.__SP && window.__SP.utils;
        if (utils && typeof utils.bucket === 'function') {
          var b = utils.bucket(contract);
          if (b === 'active') payload.summary.active_count = 1;
          else if (b === 'paused') payload.summary.paused_count = 1;
          else if (b === 'cancelled') payload.summary.cancelled_count = 1;
          else payload.summary.other_count = 1;

          // needs_attention_count
          if (contract && contract.portalState && contract.portalState.needsAttention) {
            payload.summary.needs_attention_count = 1;
          }
        }
      } catch (e2) {}

      var entry = { ts: Date.now(), data: payload };
      sessionStorage.setItem(SUBS_CACHE_KEY, JSON.stringify(entry));
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------

  async function render() {
    if (window.__SP.analytics && window.__SP.analytics.setPage) {
      window.__SP.analytics.setPage('subscription_detail');
    }
    var ui = window.__SP.ui;
    ui.ensureBaseStyles();
    ui.setRoot(ui.loading('Loading subscription…'));

    var utils = safeGetUtils();
    if (
      !utils ||
      typeof utils.pickContracts !== 'function' ||
      typeof utils.normalizeContract !== 'function'
    ) {
      ui.setRoot(
        ui.el('div', { class: 'sp-wrap sp-grid' }, [
          ui.el('div', { class: 'sp-card' }, [
            ui.el('h2', { class: 'sp-title' }, ['Portal utils not loaded']),
            ui.el('p', { class: 'sp-muted' }, [
              'Please refresh. If this keeps happening, contact support.',
            ]),
          ]),
        ])
      );
      return;
    }

    var actions = window.__SP.actions || {};
    var cfg = getConfig();
    var contractId = getContractIdFromUrl();

    // URLs for cancel flow + always-available exit back to details
    var pathname = '';
    try {
      pathname = String(window.location.pathname || '');
    } catch (e) {
      pathname = '';
    }

    var detailUrl = pathname + '?id=' + encodeURIComponent(String(contractId || ''));
    var cancelUrl = detailUrl + '&intent=cancel';

    if (!contractId) {
      ui.setRoot(
        ui.el('div', { class: 'sp-wrap sp-grid' }, [
          ui.el('div', { class: 'sp-card' }, [
            ui.el('h2', { class: 'sp-title' }, ['Missing subscription id']),
            ui.el('p', { class: 'sp-muted' }, ['Please go back and open the subscription again.']),
          ]),
        ])
      );
      return;
    }

    // 1) Try subscriptions cache first (no network)
    var cachedPayload = readSubscriptionsCachePayload();
    var contract = cachedPayload ? findContractInPayload(cachedPayload, contractId, utils) : null;

    // 2) If cache miss, fetch direct (no cache write)
    if (!contract) {
      try {
        var detailResp = await fetchSubscriptionDetailDirect(contractId);
        contract = normalizeDetailResponse(detailResp, utils);
        // ✅ write one-contract cache so cancel/frequency/etc use normal wiring
        if (contract) writeDetailAsSubscriptionsCache(contract, contractId);
      } catch (e) {
        try {
          console.error('[Portal] subscriptionDetail fetch error:', e);
        } catch (_) {}
        ui.setRoot(
          ui.el('div', { class: 'sp-wrap sp-grid' }, [
            ui.el('div', { class: 'sp-card' }, [
              ui.el('h2', { class: 'sp-title' }, ['Could not load subscription']),
              ui.el('p', { class: 'sp-muted' }, [
                'Please refresh. If this keeps happening, contact support.',
              ]),
            ]),
          ])
        );
        return;
      }
    }

    if (!contract) {
      ui.setRoot(
        ui.el('div', { class: 'sp-wrap sp-grid' }, [
          ui.el('div', { class: 'sp-card' }, [
            ui.el('h2', { class: 'sp-title' }, ['Subscription not found']),
            ui.el('p', { class: 'sp-muted' }, [
              'We couldn’t find that subscription in your account.',
            ]),
          ]),
        ])
      );
      return;
    }

    contract = utils.normalizeContract(contract);

    // Analytics: detail view (once per session per contract)
    try {
      tryFireSubscriptionDetailViewOncePerSession(contract, utils);
    } catch (e) {}

    // --- make the loaded contract available to other screens (cancel flow, etc) ---
    try {
      window.__SP = window.__SP || {};
      window.__SP.state = window.__SP.state || {};

      // cancel screen looks here first
      window.__SP.state.currentContract = contract;

      // helpful extra fields (optional, harmless)
      window.__SP.state.currentContractId =
        utils && utils.shortId ? utils.shortId(contract && contract.id) : contractId || '';
    } catch (e) {}

    var bucket = utils.bucket(contract);
    var needsAttention = !!(
      contract &&
      contract.portalState &&
      contract.portalState.needsAttention
    );

    var statusText =
      bucket === 'cancelled' ? 'Cancelled' : bucket === 'paused' ? 'Paused' : 'Active';
    var statusKind =
      bucket === 'cancelled' ? 'cancelled' : bucket === 'paused' ? 'paused' : 'active';

    var createdMs = toNumDate(contract.createdAt);
    var now = Date.now();
    var ageDays = createdMs ? daysBetween(createdMs, now) : 9999;
    var isYoung = ageDays < cfg.lockDays;
    var isPortalLocked = !!cfg.portalLock;
    var isCancelled = bucket === 'cancelled';
    var isReadOnly = isYoung || isPortalLocked || isCancelled;

    // Split shipping protection line from items
    var linesAll = Array.isArray(contract.lines) ? contract.lines : [];
    var shipLine = null;
    var lines = [];

    for (var i = 0; i < linesAll.length; i++) {
      var ln = linesAll[i];
      if (!ln) continue;
      try {
        if (utils.isShippingProtectionLine && utils.isShippingProtectionLine(ln) && !shipLine) {
          shipLine = ln;
          continue;
        }
      } catch (e) {}
      lines.push(ln);
    }

    // Prefetch featured reviews (non-blocking)
    // - Skip cancelled subscriptions (no point fetching)
    // - We only fetch for "real lines" (shipping protection already split out)
    // - Product IDs are Shopify numeric IDs (gid shortId)
    var productIds = [];

    if (bucket !== 'cancelled') {
      try {
        var seenPid = {};
        for (var rp = 0; rp < lines.length; rp++) {
          var rln = lines[rp];
          if (!rln) continue;
          var pid = '';
          try {
            pid = utils && typeof utils.shortId === 'function' ? utils.shortId(rln.productId) : '';
          } catch (e0) {
            pid = '';
          }
          if (!pid) continue;
          if (seenPid[pid]) continue;
          seenPid[pid] = 1;
          productIds.push(pid);
        }
      } catch (e1) {
        productIds = [];
      }

      try {
        var reviewsStore = window.__SP && window.__SP.data && window.__SP.data.reviews;
        if (reviewsStore && typeof reviewsStore.fetchFeatured === 'function' && productIds.length) {
          // Fire-and-forget; the reviews card will subscribe + fade in when ready.
          reviewsStore.fetchFeatured(productIds).catch(function () {});
        }
      } catch (e2) {}
    }

    // Subtitle
    var subtitleText = '';
    if (bucket === 'cancelled') {
      // No next order text for cancelled subscriptions
      subtitleText = '';
    } else if (bucket === 'paused') {
      var untilIso = contract && contract.nextBillingDate ? String(contract.nextBillingDate) : '';
      var untilLabel = untilIso ? utils.fmtDate(untilIso) : '';
      subtitleText = untilLabel ? 'Paused until ' + untilLabel : 'This subscription is paused.';
    } else if (contract && contract.nextBillingDate) {
      var nextLabel = utils.fmtDate(String(contract.nextBillingDate));
      subtitleText = nextLabel ? 'Your next order is on ' + nextLabel : '';
    } else {
      subtitleText = 'Your next order date is not available';
    }

    // Header
    var header = ui.el('div', { class: 'sp-card sp-detail__header' }, [
      ui.el('div', { class: 'sp-detail__header-top' }, [
        ui.el('div', { class: 'sp-detail__titlewrap' }, [
          ui.el('h2', { class: 'sp-title sp-detail__title' }, ['Subscription details']),
          ui.el('p', { class: 'sp-muted sp-detail__subtitle' }, [subtitleText]),
        ]),
        pill(ui, statusText, statusKind),
      ]),
    ]);

    // Notices
    var notices = [];

    if (needsAttention) {
      var msg =
        contract.portalState && contract.portalState.attentionMessage
          ? String(contract.portalState.attentionMessage)
          : 'Action needed: we couldn’t process your most recent payment. Please update your payment method or contact support.';
      notices.push(renderAlert(ui, 'Action needed', msg));
    }

    if (isYoung) {
      notices.push(
        renderAlert(
          ui,
          'Heads up',
          'Your subscription is being set up. Once you receive your first order, you can return here and make edits to upcoming orders.'
        )
      );
    } else if (isPortalLocked) {
      notices.push(
        renderAlert(
          ui,
          'Heads up',
          'This subscription is currently locked. You can still contact support if you need help.'
        )
      );
    }

    // Shared card opts
    var commonOpts = {
      bucket: bucket,
      isReadOnly: isReadOnly,
      cfg: cfg,
      actions: actions,

      // data
      linesAll: linesAll,
      lines: lines,
      shipLine: shipLine,
      productIds: productIds,

      // allow cards to trigger a refresh
      rerender: function () {
        try {
          render();
        } catch (e) {}
      },
    };

    var cardCtx = Object.assign(
      {
        contract: contract,
        utils: utils,
        actions: actions,
        isReadOnly: isReadOnly,
        bucket: bucket,

        // handy extras for some cards
        linesAll: linesAll,
        shipLine: shipLine,
        lines: lines,

        // product ids (real lines only)
        productIds: productIds,

        // cancel flow navigation helpers
        detailUrl: detailUrl,
        cancelUrl: cancelUrl,
      },
      commonOpts || {}
    );

    // Left column cards
    var pauseCardEl = null;
    if (bucket === 'paused') {
      pauseCardEl = safeCardRender('resume', ui, cardCtx);
      if (!pauseCardEl)
        pauseCardEl = placeholderCard(
          ui,
          'Resume',
          'Restart your subscription when you are ready.'
        );
    } else if (bucket === 'active') {
      pauseCardEl = safeCardRender('pause', ui, cardCtx);
      if (!pauseCardEl)
        pauseCardEl = placeholderCard(ui, 'Pause', 'Pause pushes your next order out from today.');
    }
    var addressCardEl = null;
    if (bucket !== 'cancelled') {
      addressCardEl =
        safeCardRender('address', ui, cardCtx) ||
        placeholderCard(ui, 'Shipping', 'Update where your next order ships.');
    }

    var shipProtCardEl = null;
    if (bucket !== 'cancelled') {
      shipProtCardEl =
        safeCardRender('shippingProtection', ui, cardCtx) ||
        placeholderCard(
          ui,
          'Shipping Protection',
          'Protect orders from loss or theft during shipping.'
        );
    }
    var couponCardEl = null;
    if (bucket !== 'cancelled') {
      couponCardEl =
        safeCardRender('coupon', ui, cardCtx) ||
        placeholderCard(ui, 'Coupon', 'Apply a discount to your next subscription order.');
    }
    var rewardsCardEl = null;
    if (bucket !== 'cancelled') {
      rewardsCardEl =
        safeCardRender('rewards', ui, cardCtx) ||
        placeholderCard(ui, 'Rewards', 'Your points and perks.');
    }

    // Right column cards
    var frequencyCardEl = null;
    if (bucket !== 'cancelled') {
      frequencyCardEl =
        safeCardRender('frequency', ui, cardCtx) ||
        placeholderCard(ui, 'Your Schedule', 'How often your superfoods are sent.');
    }

    var itemsCardEl =
      safeCardRender('items', ui, cardCtx) ||
      placeholderCard(ui, 'Items', 'What’s included in your subscription.');

    var addonsCardEl = null;
    if (bucket !== 'cancelled') {
      // addonsCardEl =
      //   safeCardRender('addons', ui, cardCtx) ||
      //   placeholderCard(ui, 'One-time add-ons', 'Add to your next order (one-time only).');
    }
    var reviewsCardEl = null;
    if (bucket !== 'cancelled') {
      var reviewsCardEl =
        safeCardRender('reviews', ui, cardCtx) ||
        placeholderCard(ui, 'Reviews', 'What customers are saying.');
    }

    // Cancel card: do NOT show during lock windows (7-day lock OR portal lock)
    var cancelCardEl = null;
    if (!isReadOnly && bucket !== 'cancelled') {
      cancelCardEl =
        safeCardRender('cancel', ui, Object.assign({}, cardCtx, { canCancel: true })) ||
        placeholderCard(ui, 'Cancel subscription', 'We’ll ask a couple quick questions first.');
    }

    // Layout
    var main = ui.el('div', { class: 'sp-wrap sp-detail' }, [header]);
    for (var n = 0; n < notices.length; n++) main.appendChild(notices[n]);

    var grid = ui.el('div', { class: 'sp-grid sp-detail__grid' }, [
      ui.el(
        'div',
        { class: 'sp-detail__col' },
        [pauseCardEl, itemsCardEl, frequencyCardEl, addonsCardEl].filter(Boolean)
      ),
      ui.el(
        'div',
        { class: 'sp-detail__col' },
        [
          rewardsCardEl,
          couponCardEl,
          addressCardEl,
          shipProtCardEl,
          reviewsCardEl,
          cancelCardEl,
        ].filter(Boolean)
      ),
    ]);

    main.appendChild(grid);
    ui.setRoot(main);
  }

  window.__SP.screens.subscriptionDetail = { render: render };
})();
