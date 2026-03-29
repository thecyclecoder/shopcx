// assets/portal-subscriptions.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.screens = window.__SP.screens || {};

  function getPortalBase() {
    var p =
      window.__SP && window.__SP.portalPage ? String(window.__SP.portalPage) : '/pages/portal';
    return p.replace(/\/+$/, '');
  }

  function getStatusFromUrl() {
    var params = new URLSearchParams(window.location.search || '');
    var s = (params.get('status') || 'active').toLowerCase();
    if (s !== 'active' && s !== 'paused' && s !== 'cancelled') s = 'active';
    return s;
  }

  // ---------------------------------------------------------------------------
  // Analytics (subscriptions list view)
  // - fires once per browser session per status tab
  // - "manageable_count" = active + paused
  // ---------------------------------------------------------------------------

  var SUBS_VIEW_FLAG_PREFIX = '__sp_portal_subscriptions_view_v1:'; // + status

  function safeStr(v) {
    return typeof v === 'string' ? v : v == null ? '' : String(v);
  }

  function getAnalytics() {
    return (window.__SP && window.__SP.analytics) || null;
  }

  function tryFireSubscriptionsViewOncePerSession(status, manageableCount) {
    try {
      if (typeof sessionStorage === 'undefined') return;

      var st = safeStr(status).toLowerCase() || 'active';
      var key = SUBS_VIEW_FLAG_PREFIX + st;
      if (sessionStorage.getItem(key) === '1') return;

      var a = getAnalytics();
      if (!a) return;

      // Preferred: unified send()
      if (typeof a.send === 'function') {
        a.send('portal_subscriptions_view', {
          status: st,
          subscription_count: Number(manageableCount) || 0, // active + paused
        });
      } else if (typeof a.portalAction === 'function') {
        // Fallback if your wrapper only exposes portalAction()
        a.portalAction('subscriptions_view', {
          status: st,
          subscription_count: Number(manageableCount) || 0,
        });
      }

      sessionStorage.setItem(key, '1');
    } catch (e) {}
  }

  var SUBS_CACHE_KEY = '__sp_subscriptions_cache_v2';

  function maybeClearDetailPageCache() {
    try {
      var raw = sessionStorage.getItem(SUBS_CACHE_KEY);
      if (!raw) return;

      var entry;
      try {
        entry = JSON.parse(raw);
      } catch (e) {
        return;
      }
      if (!entry || !entry.data) return;

      // ✅ if cache came from detail page, nuke it so list fetches fresh
      if (entry.data && entry.data.setBy === 'detailPage') {
        sessionStorage.removeItem(SUBS_CACHE_KEY);
      }
    } catch (e) {}
  }

  function pill(ui, text, kind) {
    var cls = 'sp-pill sp-pill--neutral';
    if (kind === 'active') cls = 'sp-pill sp-pill--active';
    if (kind === 'cancelled') cls = 'sp-pill sp-pill--cancelled';
    if (kind === 'paused') cls = 'sp-pill sp-pill--paused';
    return ui.el('span', { class: cls }, [text]);
  }

  function statusFromContract(contract, utils) {
    var b = utils.bucket(contract);

    if (b === 'cancelled') return { kind: 'cancelled', text: 'Cancelled' };
    if (b === 'paused') return { kind: 'paused', text: 'Paused' };
    if (b === 'active') return { kind: 'active', text: 'Active' };

    // fallback to raw status
    var raw = utils.normalizeStatus(contract && contract.status);
    return { kind: 'neutral', text: raw || 'Unknown' };
  }

  function billingMetaText(contract, utils) {
    var b = utils.bucket(contract);

    // Paused: "Paused until Apr 6, 2026" (uses nextBillingDate as the effective "until")
    if (b === 'paused') {
      var untilIso = contract && contract.nextBillingDate ? String(contract.nextBillingDate) : '';
      var untilLabel = untilIso ? utils.fmtDate(untilIso) : '';
      return untilLabel ? 'Paused until ' + untilLabel : 'Paused';
    }

    // Normal: "Monthly • Next: Apr 6, 2026"
    var label = utils.billingLabel(contract && contract.billingPolicy) || 'Billing schedule';
    var nextIso = contract && contract.nextBillingDate ? String(contract.nextBillingDate) : '';
    var nextLabel = nextIso ? utils.fmtDate(nextIso) : '';
    return nextLabel ? label + ' • Next: ' + nextLabel : label;
  }

  function getLineImageUrl(ln, utils) {
    // contract-external returns variantImage.transformedSrc (not variantImageUrl)
    return utils.safeStr(ln && ln.variantImage && ln.variantImage.transformedSrc);
  }

  function needsAttention(contract) {
    // The backend should set this: contract.portalState.needsAttention
    try {
      return !!(contract && contract.portalState && contract.portalState.needsAttention);
    } catch (e) {
      return false;
    }
  }

  function attentionText(contract, utils) {
    // Default copy (can be refined later)
    var msg = '';
    try {
      msg = utils.safeStr(
        contract && contract.portalState && contract.portalState.attentionMessage
      );
    } catch (e) {}
    return msg || 'Action needed: payment failed';
  }

  function renderAttentionAlert(ui, contract, utils) {
    return ui.el('div', { class: 'sp-alert sp-alert--danger' }, [
      ui.el('div', { class: 'sp-alert__title' }, ['Action needed']),
      ui.el('div', { class: 'sp-alert__body' }, [attentionText(contract, utils)]),
    ]);
  }

  function renderContractCard(ui, contract, utils) {
    var base = getPortalBase();
    var st = statusFromContract(contract, utils);

    // Lines already normalized by portal-utils: contract.lines is ARRAY
    var linesAll = Array.isArray(contract && contract.lines) ? contract.lines : [];
    var shipLine = null;
    var lines = [];

    linesAll.forEach(function (ln) {
      if (!ln) return;
      if (utils.isShippingProtectionLine(ln) && !shipLine) shipLine = ln;
      else lines.push(ln);
    });

    // Optional alert banner inside card (top)
    var showAlert = needsAttention(contract);

    var titleRow = ui.el('div', { class: 'sp-subcard__header sp-row' }, [
      ui.el('div', { class: 'sp-subcard__header-left' }, [
        ui.el('div', { class: 'sp-subcard__title' }, ['Superfoods']),
        ui.el('div', { class: 'sp-subcard__meta sp-muted' }, [billingMetaText(contract, utils)]),
      ]),
      pill(ui, st.text, st.kind),
    ]);

    var linesWrap = ui.el('div', { class: 'sp-subcard__lines' }, []);

    if (!lines.length) {
      linesWrap.appendChild(
        ui.el('p', { class: 'sp-muted sp-subcard__empty' }, [
          'No items found on this subscription.',
        ])
      );
    } else {
      var shown = lines.slice(0, 3);
      shown.forEach(function (ln) {
        var row = ui.el('div', { class: 'sp-line' }, []);

        var imgUrl = getLineImageUrl(ln, utils);
        if (imgUrl) {
          row.appendChild(
            ui.el('img', {
              class: 'sp-line__img',
              src: imgUrl,
              alt: utils.safeStr(ln.title) || 'Item',
            })
          );
        } else {
          row.appendChild(ui.el('div', { class: 'sp-line__img sp-line__img--placeholder' }, []));
        }

        var meta = ui.el('div', { class: 'sp-line__meta' }, [
          ui.el('div', { class: 'sp-line__title' }, [utils.safeStr(ln.title) || 'Item']),
          ui.el('div', { class: 'sp-line__subwrap sp-muted' }, [
            ln.variantTitle
              ? ui.el('div', { class: 'sp-line__variant' }, [utils.safeStr(ln.variantTitle)])
              : null,
            ui.el('div', { class: 'sp-line__qty' }, ['Qty ' + String(ln.quantity || 1)]),
          ]),
        ]);

        var priceText = '';
        if (ln.currentPrice) priceText = utils.money(ln.currentPrice);

        var price = ui.el('div', { class: 'sp-line__price' }, [priceText || '']);

        row.appendChild(meta);
        row.appendChild(price);
        linesWrap.appendChild(row);
      });

      if (lines.length > 3) {
        var remaining = lines.length - 3;
        linesWrap.appendChild(
          ui.el('div', { class: 'sp-subcard__more sp-muted' }, [
            '+ ' + remaining + ' other ' + (remaining === 1 ? 'item' : 'items'),
          ])
        );
      }
    }

    var contractId = utils.shortId(contract && contract.id);
    var detailHref = base + '/subscription?id=' + encodeURIComponent(contractId || '');

    var actions = ui.el('div', { class: 'sp-subcard__actions' }, [
      ui.el('a', { class: 'sp-btn', href: detailHref }, ['View details']),
    ]);

    if (shipLine) {
      var shipImgUrl = getLineImageUrl(shipLine, utils);

      actions.appendChild(
        ui.el('div', { class: 'sp-shipprot' }, [
          shipImgUrl
            ? ui.el('img', {
                class: 'sp-shipprot__img',
                src: shipImgUrl,
                alt: 'Shipping Protection',
              })
            : ui.el('div', { class: 'sp-shipprot__img sp-shipprot__img--placeholder' }, []),
          ui.el('div', { class: 'sp-shipprot__text' }, [
            ui.el('div', { class: 'sp-shipprot__title' }, ['Shipping Protection']),
            ui.el('div', { class: 'sp-shipprot__sub sp-muted' }, [
              'Orders are protected from loss or theft during shipping',
            ]),
          ]),
        ])
      );
    }

    var children = [];
    if (showAlert) children.push(renderAttentionAlert(ui, contract, utils));
    children.push(titleRow);
    children.push(linesWrap);
    children.push(actions);

    return ui.el('div', { class: 'sp-card sp-subcard' }, children);
  }

  function setActiveTabClass(tabsEl, status) {
    if (!tabsEl) return;
    var desired = String(status || 'active').toLowerCase();
    var btns = tabsEl.querySelectorAll('.sp-tab');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var tab = String(b.getAttribute('data-tab') || '').toLowerCase();
      if (tab === desired) b.classList.add('is-active');
      else b.classList.remove('is-active');
    }
  }

  function wireTabClicks(tabsEl) {
    if (!tabsEl) return;
    tabsEl.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('.sp-tab') : null;
      if (!a || !tabsEl.contains(a)) return;
      setActiveTabClass(tabsEl, a.getAttribute('data-tab') || 'active');
    });
  }

  async function fetchSubscriptions() {
    if (!window.__SP.api || typeof window.__SP.api.requestJson !== 'function') {
      throw new Error('API not loaded');
    }
    return await window.__SP.api.requestJson('subscriptions');
  }

  async function render() {
    var ui = window.__SP.ui;
    ui.ensureBaseStyles();
    ui.setRoot(ui.loading('Loading subscriptions…'));

    var utils = window.__SP && window.__SP.utils;
    if (!utils || typeof utils.pickBuckets !== 'function') {
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

    var base = getPortalBase();
    var status = getStatusFromUrl();

    var data;
    try {
      // ✅ ensure we never show only 1 contract on the list view
      maybeClearDetailPageCache();
      data = await fetchSubscriptions();
    } catch (e) {
      console.error('[Portal] subscriptions error:', e);
      ui.setRoot(
        ui.el('div', { class: 'sp-wrap sp-grid' }, [
          ui.el('div', { class: 'sp-card' }, [
            ui.el('h2', { class: 'sp-title' }, ['Could not load subscriptions']),
            ui.el('p', { class: 'sp-muted' }, [
              'Please refresh. If this keeps happening, contact support.',
            ]),
          ]),
        ])
      );
      return;
    }

    if (!data || data.ok !== true) {
      ui.setRoot(
        ui.el('div', { class: 'sp-wrap sp-grid' }, [
          ui.el('div', { class: 'sp-card' }, [
            ui.el('h2', { class: 'sp-title' }, ['Could not load subscriptions']),
            ui.el('p', { class: 'sp-muted' }, [
              'Please refresh. If this keeps happening, contact support.',
            ]),
          ]),
        ])
      );
      return;
    }

    var buckets = utils.pickBuckets(data);

    // Analytics: list view + manageable subscription count (active + paused)
    try {
      var activeCount = buckets && Array.isArray(buckets.active) ? buckets.active.length : 0;
      var pausedCount = buckets && Array.isArray(buckets.paused) ? buckets.paused.length : 0;
      var manageableCount = activeCount + pausedCount;
      if (window.__SP.analytics && window.__SP.analytics.setPage) {
        window.__SP.analytics.setPage('subscriptions');
      }

      tryFireSubscriptionsViewOncePerSession(status, manageableCount);
    } catch (e) {}

    // ✅ DEBUG: force first ACTIVE subscription to show attention banner
    // (Only when window.__SP.debug is true)
    // try {
    //   if (
    //     window.__SP &&
    //     window.__SP.debug &&
    //     buckets &&
    //     Array.isArray(buckets.active) &&
    //     buckets.active.length
    //   ) {
    //     var c0 = buckets.active[0];
    //     c0.portalState = c0.portalState || {};
    //     c0.portalState.needsAttention = true;
    //     c0.portalState.attentionMessage = 'Action needed: payment failed (debug)';
    //   }
    // } catch (e) {}

    var contracts =
      status === 'active'
        ? buckets.active
        : status === 'paused'
          ? buckets.paused
          : buckets.cancelled;

    var tabs = ui.el('div', { class: 'sp-tabs' }, [
      ui.el(
        'a',
        { class: 'sp-tab', href: base + '/subscriptions?status=active', 'data-tab': 'active' },
        ['Active']
      ),
      ui.el(
        'a',
        { class: 'sp-tab', href: base + '/subscriptions?status=paused', 'data-tab': 'paused' },
        ['Paused']
      ),
      ui.el(
        'a',
        {
          class: 'sp-tab',
          href: base + '/subscriptions?status=cancelled',
          'data-tab': 'cancelled',
        },
        ['Cancelled']
      ),
    ]);

    setActiveTabClass(tabs, status);
    wireTabClicks(tabs);

    var headerCard = ui.el('div', { class: 'sp-card sp-subs-header' }, [
      // ui.el("h2", { class: "sp-title" }, ["Your subscriptions"]),
      ui.el('div', { class: 'sp-subs-header__tabs' }, [tabs]),
    ]);

    var listWrap = ui.el('div', { class: 'sp-grid sp-subs-list' }, []);

    if (!contracts.length) {
      var msg =
        status === 'cancelled'
          ? 'You don’t have any cancelled subscriptions.'
          : status === 'paused'
            ? 'You don’t have any paused subscriptions.'
            : 'You don’t have any active subscriptions.';

      listWrap.appendChild(
        ui.el('div', { class: 'sp-card' }, [
          ui.el('div', { class: 'sp-empty-title' }, ['No subscriptions found']),
          ui.el('p', { class: 'sp-muted sp-empty-sub' }, [msg]),
        ])
      );
    } else {
      contracts.forEach(function (c) {
        listWrap.appendChild(renderContractCard(ui, c, utils));
      });
    }

    ui.setRoot(ui.el('div', { class: 'sp-wrap' }, [headerCard, listWrap]));
  }

  window.__SP.screens.subscriptions = { render: render };
})();
