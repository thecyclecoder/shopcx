// assets/modals/review.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.modals = window.__SP.modals || {};

  function safeStr(v) {
    return typeof v === 'string' ? v : v == null ? '' : String(v);
  }

  function ensureBodyNoScroll(on) {
    try {
      if (on) document.body.classList.add('sp-modal-open');
      else document.body.classList.remove('sp-modal-open');
    } catch (e) {}
  }

  function closeModal(state) {
    try {
      if (state._onKeyDown) document.removeEventListener('keydown', state._onKeyDown);
    } catch (e) {}

    try {
      if (state.root && state.root.parentNode) state.root.parentNode.removeChild(state.root);
    } catch (e2) {}

    ensureBodyNoScroll(false);

    try {
      state.root = null;
      state._onKeyDown = null;
    } catch (e3) {}
  }

  function formatDateShort(iso) {
    var s = safeStr(iso).trim();
    if (!s) return '';
    try {
      var d = new Date(s);
      if (!isFinite(d.getTime())) return '';
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) {
      return '';
    }
  }

  function pickTitle(review) {
    var t = safeStr(review && (review.smartQuote || review.smart_quote)).trim();
    if (t) return t;
    t = safeStr(review && review.title).trim();
    if (t) return t;
    return 'Customer review';
  }

  function pickBody(review) {
    return safeStr(review && (review.content != null ? review.content : review.body)).trim();
  }

  function pickAuthor(review) {
    var a = safeStr(review && review.author).trim();
    return a || 'Verified Customer';
  }

  function normalizeKlaviyoImageUrl(u) {
    var s = safeStr(u).trim();
    if (!s) return '';

    // already absolute
    if (s.indexOf('http://') === 0 || s.indexOf('https://') === 0 || s.indexOf('//') === 0)
      return s;

    // relative klaviyo image key -> prepend media proxy
    return (
      'https://reviews-media.services.klaviyo.com/abc/width:150/plain/https://klaviyo.s3.amazonaws.com/reviews/images/' +
      s.replace(/^\/+/, '')
    );
  }

  function pickImages(review) {
    var imgs = review && review.images;
    if (!Array.isArray(imgs)) return [];
    var out = [];
    for (var i = 0; i < imgs.length; i++) {
      var full = normalizeKlaviyoImageUrl(imgs[i]);
      if (full) out.push(full);
    }
    return out;
  }

  function svgStar() {
    return (
      '<svg class="sp-reviewmodal__star" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.6L12 17.9 6.1 20.6 7.3 14 2.5 9.4l6.6-.9L12 2.5z"></path>' +
      '</svg>'
    );
  }

  function svgClose() {
    return (
      '<svg class="sp-reviewmodal__closeicon" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>' +
      '<path d="M6 6l12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>' +
      '</svg>'
    );
  }

  function open(review) {
    var ui = window.__SP && window.__SP.ui;
    if (!ui || typeof ui.el !== 'function') return;

    var state = { root: null, _onKeyDown: null };

    var titleText = pickTitle(review);
    var bodyText = pickBody(review);
    var authorText = pickAuthor(review);
    var dateText = formatDateShort(review && review.createdAt);
    var images = pickImages(review);

    var overlay = ui.el(
      'div',
      { class: 'sp-modal sp-reviewmodal', role: 'dialog', 'aria-modal': 'true' },
      []
    );
    var card = ui.el('div', { class: 'sp-modal__card sp-reviewmodal__card' }, []);

    // Header (premium layout)
    var header = ui.el('div', { class: 'sp-reviewmodal__header' }, []);

    var stars = ui.el(
      'div',
      { class: 'sp-reviewmodal__stars', 'aria-label': '5 out of 5 stars' },
      []
    );
    stars.innerHTML = svgStar() + svgStar() + svgStar() + svgStar() + svgStar();

    var closeBtn = ui.el(
      'button',
      { type: 'button', class: 'sp-reviewmodal__closebtn', 'aria-label': 'Close' },
      []
    );
    closeBtn.innerHTML = svgClose();
    closeBtn.addEventListener('click', function () {
      closeModal(state);
    });

    var heading = ui.el('div', { class: 'sp-reviewmodal__heading' }, [
      ui.el('div', { class: 'sp-reviewmodal__title' }, [titleText]),
      ui.el('div', { class: 'sp-reviewmodal__meta' }, [
        ui.el('span', { class: 'sp-reviewmodal__author' }, [authorText]),
        ui.el('span', { class: 'sp-reviewmodal__verified' }, [
          ui.el('span', { class: 'sp-reviewmodal__verifiedicon', 'aria-hidden': 'true' }, ['✓']),
          ui.el('span', { class: 'sp-reviewmodal__verifiedtext' }, ['Verified']),
        ]),
        // dateText
        //   ? ui.el('span', { class: 'sp-reviewmodal__date sp-muted' }, [dateText])
        //   : ui.el('span', {}, []),
      ]),
    ]);

    var headerLeft = ui.el('div', { class: 'sp-reviewmodal__headerleft' }, [stars, heading]);
    header.appendChild(headerLeft);
    header.appendChild(closeBtn);

    // Body (scrollable)
    var contentWrap = ui.el('div', { class: 'sp-reviewmodal__body' }, []);
    var content = ui.el('div', { class: 'sp-reviewmodal__content' }, [
      ui.el('p', { class: 'sp-reviewmodal__text sp-muted' }, [
        bodyText ? '“' + bodyText + '”' : '',
      ]),
    ]);
    contentWrap.appendChild(content);

    // Images (2-column grid)
    if (images.length) {
      var gallery = ui.el('div', { class: 'sp-reviewmodal__gallery' }, []);
      var galleryTitle = ui.el('div', { class: 'sp-reviewmodal__gallerytitle' }, [
        'Customer photos',
      ]);
      var grid = ui.el('div', { class: 'sp-reviewmodal__grid' }, []);

      for (var i = 0; i < images.length; i++) {
        var img = ui.el('img', {
          class: 'sp-reviewmodal__image',
          src: images[i],
          alt: 'Review image',
          loading: 'lazy',
        });
        var cell = ui.el('div', { class: 'sp-reviewmodal__cell' }, [img]);
        grid.appendChild(cell);
      }

      gallery.appendChild(galleryTitle);
      gallery.appendChild(grid);
      contentWrap.appendChild(gallery);
    }

    // Footer (minimal)
    var footer = ui.el('div', { class: 'sp-reviewmodal__footer' }, [
      ui.el('button', { type: 'button', class: 'sp-btn sp-btn--ghost sp-reviewmodal__footerbtn' }, [
        'Close',
      ]),
    ]);
    footer.querySelector('button').addEventListener('click', function () {
      closeModal(state);
    });

    card.appendChild(header);
    card.appendChild(contentWrap);
    card.appendChild(footer);
    overlay.appendChild(card);

    // Overlay click closes when clicking outside the card
    overlay.addEventListener('click', function (e) {
      if (e && e.target === overlay) closeModal(state);
    });

    // Esc closes
    state._onKeyDown = function (e) {
      try {
        if (e && (e.key === 'Escape' || e.keyCode === 27)) closeModal(state);
      } catch (err) {}
    };
    document.addEventListener('keydown', state._onKeyDown);

    state.root = overlay;
    ensureBodyNoScroll(true);
    document.body.appendChild(overlay);
  }

  window.__SP.modals.review = { open: open };
})();
