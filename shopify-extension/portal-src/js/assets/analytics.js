// assets/analytics.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.analytics = window.__SP.analytics || {};

  var DEBUG = !!(window.__SP && window.__SP.debug);

  function log() {
    if (!DEBUG) return;
    try {
      console.log.apply(console, arguments);
    } catch (e) {}
  }

  function safeStr(v) {
    return typeof v === 'string' ? v : v == null ? '' : String(v);
  }

  function hasGtag() {
    return typeof window.gtag === 'function';
  }

  function nowTs() {
    return Date.now();
  }

  // --------------------------------------------------
  // Page context (prevents stale portal_page across SPA-ish navigation)
  // --------------------------------------------------

  var PAGE_KEY = '__sp_portal_page_v1';

  function ssGet(k) {
    try {
      return sessionStorage.getItem(k);
    } catch (e) {
      return null;
    }
  }

  function ssSet(k, v) {
    try {
      sessionStorage.setItem(k, v);
    } catch (e) {}
  }

  function getCurrentPage() {
    // Prefer live in-memory (window.__SP.currentScreen) if present,
    // otherwise use the last known page stored in sessionStorage.
    var live = '';
    try {
      live = safeStr(window.__SP && window.__SP.currentScreen);
    } catch (e) {}
    return live || safeStr(ssGet(PAGE_KEY));
  }

  function setPage(page) {
    var p = safeStr(page).trim();
    if (!p) return;

    // Store in sessionStorage so subsequent events fired during in-flight
    // navigation never inherit a stale portal_page.
    ssSet(PAGE_KEY, p);

    // Also set currentScreen so existing code paths keep working.
    try {
      window.__SP.currentScreen = p;
    } catch (e) {}
  }

  // --------------------------------------------------
  // Subscription Age Bucket Helper
  // --------------------------------------------------

  function getAgeBucketFromDays(days) {
    var d = Number(days);
    if (!isFinite(d) || d < 0) return 'unknown';

    if (d <= 30) return '0_30';
    if (d <= 60) return '30_60';
    if (d <= 90) return '60_90';
    return '90_plus';
  }

  function getAgeBucketFromCreatedAt(createdAtIso) {
    try {
      var t = new Date(String(createdAtIso || '')).getTime();
      if (!isFinite(t)) return 'unknown';
      var days = Math.floor((Date.now() - t) / 86400000);
      if (days < 0) days = 0;
      return getAgeBucketFromDays(days);
    } catch (e) {
      return 'unknown';
    }
  }

  // --------------------------------------------------
  // Core Event Sender
  // --------------------------------------------------

  function send(eventName, params) {
    if (!eventName) return;

    var payload = params && typeof params === 'object' ? params : {};

    payload.portal_ts = nowTs();

    // Always populate portal_page from current context (live > session fallback)
    payload.portal_page = safeStr(payload.portal_page).trim() || getCurrentPage() || '';

    // Normalize optional core dimensions so GA4 always sees them
    payload.action = safeStr(payload.action || '');
    payload.reason = safeStr(payload.reason || '');
    payload.offer_type = safeStr(payload.offer_type || '');
    payload.age_bucket = safeStr(payload.age_bucket || '');
    payload.status = safeStr(payload.status || '');

    // Only include subscription_count if explicitly provided
    if (payload.hasOwnProperty('subscription_count')) {
      var sc = Number(payload.subscription_count);
      if (isFinite(sc)) {
        payload.subscription_count = sc;
      } else {
        delete payload.subscription_count;
      }
    }

    if (!hasGtag()) {
      log('[Analytics] gtag not found:', eventName, payload);
      return;
    }

    try {
      window.gtag('event', eventName, payload);
      log('[Analytics] Sent:', eventName, payload);
    } catch (e) {
      log('[Analytics] Failed:', e);
    }
  }

  // --------------------------------------------------
  // Convenience Methods (Standardized Events)
  // --------------------------------------------------

  function portalAction(actionName, extra) {
    var payload = extra && typeof extra === 'object' ? extra : {};
    payload.action = safeStr(actionName);

    send('portal_action', payload);
  }

  function cancelStarted(ageBucket) {
    send('cancel_started', {
      age_bucket: safeStr(ageBucket),
    });
  }

  function cancelCompleted(ageBucket, reason) {
    send('cancel_completed', {
      age_bucket: safeStr(ageBucket),
      reason: safeStr(reason),
    });
  }

  function cancelSaved(ageBucket, offerType) {
    send('cancel_saved', {
      age_bucket: safeStr(ageBucket),
      offer_type: safeStr(offerType),
    });
  }

  function portalLogin(ageBucket) {
    send('portal_login', {
      age_bucket: safeStr(ageBucket),
    });
  }

  // Optional: page view helpers (nice for dashboards)
  function portalSessionStart() {
    send('portal_session_start', {});
  }

  function portalHomeView() {
    setPage('home');
    send('portal_home_view', {});
  }

  function portalSubscriptionsView(status, subscriptionCount) {
    setPage('subscriptions');
    send('portal_subscriptions_view', {
      status: safeStr(status),
      subscription_count: Number(subscriptionCount) || 0,
    });
  }

  function portalSubscriptionDetailView(opts) {
    opts = opts && typeof opts === 'object' ? opts : {};
    setPage('subscription_detail');
    send('portal_subscription_detail_view', {
      status: safeStr(opts.status),
      age_bucket: safeStr(opts.age_bucket),
    });
  }

  // --------------------------------------------------
  // Public API
  // --------------------------------------------------

  window.__SP.analytics = {
    // Core
    send: send,

    // Page context
    setPage: setPage,
    getCurrentPage: getCurrentPage,

    // Convenience
    portalAction: portalAction,
    cancelStarted: cancelStarted,
    cancelCompleted: cancelCompleted,
    cancelSaved: cancelSaved,
    portalLogin: portalLogin,

    // Helpers
    getAgeBucketFromDays: getAgeBucketFromDays,
    getAgeBucketFromCreatedAt: getAgeBucketFromCreatedAt,

    // Optional standardized views
    portalSessionStart: portalSessionStart,
    portalHomeView: portalHomeView,
    portalSubscriptionsView: portalSubscriptionsView,
    portalSubscriptionDetailView: portalSubscriptionDetailView,
  };

  log('[Analytics] Loaded.');
})();
