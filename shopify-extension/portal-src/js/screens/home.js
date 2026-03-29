// assets/portal-home.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.screens = window.__SP.screens || {};

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, function (m) {
      switch (m) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        case "'":
          return '&#039;';
        default:
          return m;
      }
    });
  }

  function safeStr(v) {
    return typeof v === 'string' ? v : v == null ? '' : String(v);
  }

  function getPortalBase() {
    var p =
      window.__SP && window.__SP.portalPage ? String(window.__SP.portalPage) : '/pages/portal';
    return p.replace(/\/+$/, '');
  }

  function getFirstNameFromDom() {
    try {
      if (window.__SP.el && window.__SP.el.getAttribute) {
        return String(window.__SP.el.getAttribute('data-first-name') || '');
      }
    } catch (e) {}
    return '';
  }

  // ---------------------------------------------------------------------------
  // Analytics: portal session start (HOME)
  //
  // Home will NEVER have age_bucket (subscription-specific), so this ONLY logs
  // that a portal session started. One fire per browser session.
  // ---------------------------------------------------------------------------

  var PORTAL_SESSION_FLAG_KEY = '__sp_portal_session_started_v1';

  function getAnalytics() {
    return (window.__SP && window.__SP.analytics) || null;
  }

  function firePortalSessionStartOncePerSession() {
    try {
      if (typeof sessionStorage === 'undefined') return;
      if (sessionStorage.getItem(PORTAL_SESSION_FLAG_KEY) === '1') return;

      var a = getAnalytics();
      if (a && typeof a.send === 'function') {
        // Prefer a dedicated event name for clean reporting
        a.send('portal_session_start', {});
      } else if (a && typeof a.portalAction === 'function') {
        // Fallback (if your analytics wrapper only exposes portalAction)
        a.portalAction('portal_session_start', {});
      }

      sessionStorage.setItem(PORTAL_SESSION_FLAG_KEY, '1');
    } catch (e) {}
  }

  async function fetchHome() {
    if (!window.__SP.api || typeof window.__SP.api.requestJson !== 'function') {
      throw new Error('api_not_loaded');
    }
    // Home is a lightweight health check now
    return await window.__SP.api.requestJson('home', {}, { force: true });
  }

  // ---------------------------------------------------------------------------
  // Cards registry helpers (match subscription-detail.js style)
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

      var out = card.render(ui, ctx);

      // Cards should return a DOM node
      if (out && (out.nodeType === 1 || out.nodeType === 11)) return out;

      // Allow legacy { el: Node }
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

  function primaryLink(ui, href, text) {
    return ui.el('a', { class: 'sp-btn sp-btn--primary', href: String(href || '#') }, [
      safeStr(text),
    ]);
  }

  function renderError(ui, title, body) {
    return ui.el('div', { class: 'sp-wrap sp-grid' }, [
      ui.el('div', { class: 'sp-card' }, [
        ui.el('div', { class: 'sp-error-title' }, [title]),
        ui.el('div', { class: 'sp-error-text sp-muted' }, [body]),
      ]),
    ]);
  }

  function renderHome(ui, data) {
    if (!data || data.ok !== true) {
      ui.setRoot(
        renderError(
          ui,
          'We hit a snag',
          'Please refresh, or contact support if this keeps happening.'
        )
      );
      return;
    }

    if (window.__SP.analytics && window.__SP.analytics.setPage) {
      window.__SP.analytics.setPage('home');
    }

    // ✅ Analytics: start portal session (once per browser session)
    firePortalSessionStartOncePerSession();

    var base = getPortalBase();
    var appName = safeStr(data.appName) || 'Subscription Portal';

    var firstName = getFirstNameFromDom();
    var greeting = firstName ? 'Welcome back, ' + esc(firstName) : 'Welcome back';

    // Home hero card (DOM, not HTML string)
    var homeCard = ui.el('div', { class: 'sp-card sp-home-card' }, [
      ui.el('div', { class: 'sp-home-header' }, [
        ui.el('div', { class: 'sp-home-header-left' }, [
          ui.el('div', { class: 'sp-home-title' }, [greeting]),
          ui.el('div', { class: 'sp-home-subtitle sp-muted' }, [esc(appName)]),
        ]),
      ]),
      ui.el('div', { class: 'sp-home-description sp-muted' }, [
        'Manage your upcoming orders, shipping details, and subscription status.',
      ]),
      ui.el('div', { class: 'sp-home-actions' }, [
        primaryLink(ui, base + '/subscriptions?status=active', 'View subscriptions'),
      ]),
    ]);

    // Rewards card (from cards/rewards.js), safe-rendered
    var ctx = { screen: 'home' };

    var rewardsCard =
      safeCardRender('rewards', ui, ctx) ||
      placeholderCard(ui, 'Rewards', 'Your points and perks.');

    var wrap = ui.el('div', { class: 'sp-wrap sp-grid sp-home' }, [homeCard, rewardsCard]);

    ui.setRoot(wrap);
  }

  async function render() {
    var ui = window.__SP.ui;
    if (!ui) return;

    // Helps analytics wrappers that include portal_page/currentScreen
    try {
      window.__SP.currentScreen = 'home';
    } catch (e) {}

    ui.ensureBaseStyles();
    ui.setRoot(ui.loading('Loading your portal…'));

    try {
      var data = await fetchHome();
      renderHome(ui, data);
    } catch (err) {
      try {
        console.error('[Portal] home error:', err);
      } catch (_) {}
      ui.setRoot(
        renderError(
          ui,
          'Could not load portal',
          'Please refresh. If this keeps happening, contact support.'
        )
      );
    }
  }

  window.__SP.screens.home = { render: render };
})();
