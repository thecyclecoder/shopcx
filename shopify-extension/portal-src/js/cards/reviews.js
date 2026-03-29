// assets/portal-cards-reviews.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.cards = window.__SP.cards || {};
  window.__SP.cards.reviews = window.__SP.cards.reviews || {};

  function sectionTitle(ui, title, sub) {
    return ui.el('div', { class: 'sp-detail__sectionhead' }, [
      ui.el('div', { class: 'sp-title2' }, [title]),
      sub ? ui.el('p', { class: 'sp-muted sp-detail__section-sub' }, [sub]) : ui.el('span', {}, []),
    ]);
  }

  function safeStr(v) {
    return typeof v === 'string' ? v : v == null ? '' : String(v);
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

  function shortId(gidOrId) {
    var s = safeStr(gidOrId).trim();
    if (!s) return '';
    var parts = s.split('/');
    return (parts[parts.length - 1] || s).trim();
  }

  function normalizeProductId(input) {
    var sid = shortId(input);
    if (!sid) return '';
    var digits = sid.replace(/[^\d]/g, '');
    return (digits || sid).trim();
  }

  function clampInt(n, fallback, min, max) {
    var x = Number(n);
    if (!isFinite(x)) return fallback;
    x = Math.trunc(x);
    if (x < min) return min;
    if (x > max) return max;
    return x;
  }

  function pickReviewTitle(r) {
    var t = safeStr(r && r.smartQuote).trim();
    if (t) return t;
    t = safeStr(r && r.title).trim();
    if (t) return t;
    return 'Loved it';
  }

  function pickReviewBody(r) {
    return safeStr(r && (r.body != null ? r.body : r.content)).trim();
  }

  function truncateText(str, maxChars) {
    var s = safeStr(str);
    if (!s) return { text: '', truncated: false };
    if (s.length <= maxChars) return { text: s, truncated: false };
    var cut = s.slice(0, maxChars);
    var lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > Math.floor(maxChars * 0.6)) cut = cut.slice(0, lastSpace);
    return { text: cut.replace(/\s+$/, '') + '…', truncated: true };
  }

  function getContractKey(opts) {
    var c = opts && opts.contract;
    var id = c && c.id ? safeStr(c.id) : '';
    var sid = normalizeProductId(id) || shortId(id) || '';
    return 'reviews_card:' + (sid || 'unknown');
  }

  function ensureTimerRegistry() {
    window.__SP._reviewsCardTimers = window.__SP._reviewsCardTimers || {};
    return window.__SP._reviewsCardTimers;
  }

  function clearExisting(key) {
    var reg = ensureTimerRegistry();
    var prev = reg[key];
    if (!prev) return;
    try {
      if (prev.intervalId) clearInterval(prev.intervalId);
    } catch (e) {}
    try {
      if (prev.unsub) prev.unsub();
    } catch (e2) {}
    reg[key] = null;
  }

  function openReviewModal(review) {
    try {
      var m = window.__SP && window.__SP.modals && window.__SP.modals.review;
      if (m && typeof m.open === 'function') {
        m.open(review);
        return;
      }
    } catch (e) {}
  }

  function buildRotationModel(productIds, store) {
    var ids = [];
    var perProduct = {};
    for (var i = 0; i < productIds.length; i++) {
      var pid = normalizeProductId(productIds[i]);
      if (!pid) continue;
      var reviews = store && typeof store.getReviews === 'function' ? store.getReviews(pid) : [];
      if (Array.isArray(reviews) && reviews.length) {
        ids.push(pid);
        perProduct[pid] = reviews.slice();
      }
    }
    ids = uniqKeepOrder(ids);

    return {
      productIds: ids,
      perProduct: perProduct,
      productIndex: 0,
      perProductIndex: {},
      history: [],
      historyMax: 30,
    };
  }

  function setHidden(el, hidden) {
    if (!el) return;
    if (hidden) el.classList.add('sp-reviews--hidden');
    else el.classList.remove('sp-reviews--hidden');
  }

  function fadeSwap(container, swapFn) {
    if (!container) return;
    container.classList.add('sp-reviews__fade--out');
    container.classList.remove('sp-reviews__fade--in');

    window.setTimeout(function () {
      try {
        swapFn();
      } catch (e) {}
      container.classList.remove('sp-reviews__fade--out');
      container.classList.add('sp-reviews__fade--in');
    }, 180);
  }

  function pushHistory(model, item) {
    if (!model || !item) return;
    model.history.push(item);
    if (model.history.length > model.historyMax) model.history.shift();
  }

  function getNextReview(model) {
    var ids = model.productIds || [];
    if (!ids.length) return null;

    var pid = ids[model.productIndex % ids.length];
    model.productIndex = (model.productIndex + 1) % ids.length;

    var arr = model.perProduct[pid] || [];
    if (!arr.length) return null;

    var idx = model.perProductIndex[pid] || 0;
    var r = arr[idx % arr.length];
    model.perProductIndex[pid] = (idx + 1) % arr.length;

    return { productId: pid, review: r };
  }

  function getPrevFromHistory(model, current) {
    if (!model || !model.history || !model.history.length) return null;
    var curId = current && current.review ? safeStr(current.review.id) : '';
    while (model.history.length) {
      var prev = model.history.pop();
      if (!prev || !prev.review) continue;
      var prevId = safeStr(prev.review.id);
      if (!curId || prevId !== curId) return prev;
    }
    return null;
  }

  function resetInterval(state, startFn) {
    try {
      if (state.intervalId) clearInterval(state.intervalId);
    } catch (e) {}
    state.intervalId = startFn();
  }

  function svgChevron(dir) {
    // dir: "left" | "right"
    var d = dir === 'left' ? 'M14.5 18.5L8.5 12l6-6.5' : 'M9.5 5.5L15.5 12l-6 6.5';
    return (
      '<svg class="sp-reviews__chev" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="' +
      d +
      '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>' +
      '</svg>'
    );
  }

  function svgStar() {
    return (
      '<svg class="sp-reviews__star" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.6L12 17.9 6.1 20.6 7.3 14 2.5 9.4l6.6-.9L12 2.5z"></path>' +
      '</svg>'
    );
  }

  function svgQuote() {
    return (
      '<svg class="sp-reviews__quoteicon" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M10.2 11.2H6.8c.2-2.6 1.7-4.4 4.4-5.4V3.7C6.6 5 4.2 8.1 4.2 12.6c0 3.5 1.8 6 5 6 2.4 0 4.1-1.7 4.1-3.9 0-2-1.4-3.5-3.1-3.5zm9.6 0h-3.4c.2-2.6 1.7-4.4 4.4-5.4V3.7c-4.6 1.3-7 4.4-7 8.9 0 3.5 1.8 6 5 6 2.4 0 4.1-1.7 4.1-3.9 0-2-1.4-3.5-3.1-3.5z"></path>' +
      '</svg>'
    );
  }

  window.__SP.cards.reviews = {
    render: function render(ui, opts) {
      opts = opts || {};
      var contract = opts.contract || null;

      var store = window.__SP && window.__SP.data && window.__SP.data.reviews;
      var productIds = Array.isArray(opts.productIds) ? opts.productIds : [];
      productIds = productIds.map(normalizeProductId).filter(Boolean);

      if (!store || typeof store.subscribe !== 'function' || !productIds.length) return null;

      var key = getContractKey({ contract: contract });
      clearExisting(key);

      var header = sectionTitle(ui, 'Reviews', 'What customers are saying.');

      // Stars row (always 5)
      var starsEl = ui.el(
        'div',
        { class: 'sp-reviews__stars', 'aria-label': '5 out of 5 stars' },
        []
      );
      starsEl.innerHTML = svgStar() + svgStar() + svgStar() + svgStar() + svgStar();

      // Title row with quote icon
      var quoteIconWrap = ui.el(
        'span',
        { class: 'sp-reviews__quoteiconwrap', 'aria-hidden': 'true' },
        []
      );
      quoteIconWrap.innerHTML = svgQuote();

      var titleTextEl = ui.el('span', { class: 'sp-reviews__titletext' }, ['']);
      var titleEl = ui.el('div', { class: 'sp-reviews__title' }, [quoteIconWrap, titleTextEl]);

      var bodyEl = ui.el('div', { class: 'sp-reviews__body sp-muted' }, ['']);
      var linkEl = ui.el('a', { class: 'sp-reviews__link', href: '#', role: 'button' }, [
        'Read full review',
      ]);

      var authorEl = ui.el('span', { class: 'sp-reviews__author' }, ['']);
      var verifiedIcon = ui.el(
        'span',
        { class: 'sp-reviews__verifiedicon', 'aria-hidden': 'true' },
        ['✓']
      );
      var verifiedText = ui.el('span', { class: 'sp-reviews__verifiedtext' }, ['Verified']);
      var verifiedWrap = ui.el('span', { class: 'sp-reviews__verified' }, [
        verifiedIcon,
        verifiedText,
      ]);

      // SVG chevron buttons
      var prevBtn = ui.el(
        'button',
        {
          type: 'button',
          class: 'sp-reviews__navbtn sp-reviews__navbtn--prev',
          'aria-label': 'Previous review',
        },
        []
      );
      prevBtn.innerHTML = svgChevron('left');

      var nextBtn = ui.el(
        'button',
        {
          type: 'button',
          class: 'sp-reviews__navbtn sp-reviews__navbtn--next',
          'aria-label': 'Next review',
        },
        []
      );
      nextBtn.innerHTML = svgChevron('right');

      var navWrap = ui.el('div', { class: 'sp-reviews__nav' }, [prevBtn, nextBtn]);

      var metaEl = ui.el('div', { class: 'sp-reviews__meta' }, [
        ui.el('div', { class: 'sp-reviews__meta-left' }, [authorEl, verifiedWrap]),
        navWrap,
      ]);

      var inner = ui.el('div', { class: 'sp-reviews__inner sp-reviews__fade' }, [
        starsEl,
        titleEl,
        bodyEl,
        ui.el('div', { class: 'sp-reviews__actions' }, [linkEl]),
        metaEl,
      ]);

      var card = ui.el('div', { class: 'sp-card sp-detail__card sp-reviews sp-reviews--hidden' }, [
        header,
        inner,
      ]);

      var model = buildRotationModel(productIds, store);
      var current = null;
      var ROTATE_MS = 15000;
      var TRUNCATE_CHARS = clampInt(opts.truncateChars, 260, 140, 420);

      var timerState = { intervalId: null };

      function countTotalReviews(m) {
        try {
          var ids = (m && m.productIds) || [];
          var total = 0;
          for (var i = 0; i < ids.length; i++) {
            var pid = ids[i];
            var arr = (m.perProduct && m.perProduct[pid]) || [];
            total += Array.isArray(arr) ? arr.length : 0;
          }
          return total;
        } catch (e) {
          return 0;
        }
      }

      function renderCurrent(next) {
        current = next;
        if (!current || !current.review) {
          setHidden(card, true);
          return;
        }

        var r = current.review;

        var fullTitle = pickReviewTitle(r);
        var fullBody = pickReviewBody(r);
        var t = truncateText(fullBody, TRUNCATE_CHARS);

        titleTextEl.textContent = fullTitle;

        // Wrap body in quotes and keep truncation
        var bodyText = t.text || '';
        bodyEl.textContent = bodyText ? '“' + bodyText + '”' : '';

        authorEl.textContent = safeStr(r && r.author).trim()
          ? safeStr(r.author).trim()
          : 'Verified Customer';

        if (t.truncated || (fullBody && fullBody.length > TRUNCATE_CHARS)) {
          linkEl.classList.remove('sp-reviews__link--hidden');
        } else {
          linkEl.classList.add('sp-reviews__link--hidden');
        }

        var multi = countTotalReviews(model) > 1;
        if (multi) {
          navWrap.classList.remove('sp-reviews__nav--hidden');
          prevBtn.disabled = false;
          nextBtn.disabled = false;
        } else {
          navWrap.classList.add('sp-reviews__nav--hidden');
          prevBtn.disabled = true;
          nextBtn.disabled = true;
        }

        setHidden(card, false);
      }

      function reconcileModel(model, productIds, store) {
        var next = buildRotationModel(productIds, store);

        // Keep existing cursor state
        var kept = {
          productIndex: model.productIndex || 0,
          perProductIndex: model.perProductIndex || {},
          history: model.history || [],
          historyMax: model.historyMax || 30,
        };

        model.productIds = next.productIds;
        model.perProduct = next.perProduct;

        model.productIndex = kept.productIndex;
        model.perProductIndex = kept.perProductIndex;
        model.history = kept.history;
        model.historyMax = kept.historyMax;

        // If current productIndex is out of bounds, wrap
        if (model.productIds && model.productIds.length) {
          model.productIndex = model.productIndex % model.productIds.length;
        } else {
          model.productIndex = 0;
        }

        // Clean up perProductIndex keys that no longer exist
        try {
          var valid = {};
          for (var i = 0; i < model.productIds.length; i++) valid[model.productIds[i]] = 1;
          var keys = Object.keys(model.perProductIndex || {});
          for (var k = 0; k < keys.length; k++) {
            if (!valid[keys[k]]) delete model.perProductIndex[keys[k]];
          }
        } catch (e) {}

        return model;
      }

      function showNext(fade, direction) {
        // Refresh availability without resetting cursors
        model = reconcileModel(model, productIds, store);

        if (!model.productIds.length) {
          setHidden(card, true);
          return;
        }

        var next = null;

        if (direction === 'prev') {
          var prev = getPrevFromHistory(model, current);
          next = prev || getNextReview(model);
        } else {
          next = getNextReview(model);
        }

        if (!next) {
          setHidden(card, true);
          return;
        }

        if (direction !== 'prev' && current && current.review) {
          pushHistory(model, current);
        }

        if (!fade) {
          renderCurrent(next);
          return;
        }

        fadeSwap(inner, function () {
          renderCurrent(next);
        });
      }

      function startInterval() {
        return window.setInterval(function () {
          showNext(true, 'next');
        }, ROTATE_MS);
      }

      function resetAutoRotate() {
        resetInterval(timerState, startInterval);
      }

      linkEl.addEventListener('click', function (ev) {
        try {
          ev.preventDefault();
        } catch (e) {}
        if (!current || !current.review) return;

        var r = current.review;

        openReviewModal({
          id: safeStr(r.id),
          productId: current.productId,
          smartQuote: pickReviewTitle(r),
          content: pickReviewBody(r),
          author: safeStr(r.author),
          createdAt: safeStr(r.createdAt),
          images: Array.isArray(r.images) ? r.images : [],
          verified: true,
        });
      });

      prevBtn.addEventListener('click', function () {
        if (card.classList.contains('sp-reviews--hidden')) return;
        showNext(true, 'prev');
        resetAutoRotate();
      });

      nextBtn.addEventListener('click', function () {
        if (card.classList.contains('sp-reviews--hidden')) return;
        if (current && current.review) pushHistory(model, current);
        showNext(true, 'next');
        resetAutoRotate();
      });

      showNext(false, 'next');

      var unsub = store.subscribe(function (evt) {
        if (!evt || evt.type !== 'reviews:updated') return;

        var updated = evt.productIds || [];
        if (!Array.isArray(updated) || !updated.length) return;

        var hit = false;
        for (var i = 0; i < updated.length; i++) {
          if (productIds.indexOf(normalizeProductId(updated[i])) >= 0) {
            hit = true;
            break;
          }
        }
        if (!hit) return;

        if (card.classList.contains('sp-reviews--hidden')) {
          showNext(false, 'next');
          resetAutoRotate();
        } else if (!current || !current.review) {
          showNext(false, 'next');
          resetAutoRotate();
        }
      });

      timerState.intervalId = startInterval();

      var reg = ensureTimerRegistry();
      reg[key] = { intervalId: timerState.intervalId, unsub: unsub };

      return { el: card };
    },
  };
})();
