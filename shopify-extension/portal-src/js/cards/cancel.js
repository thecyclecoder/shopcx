// assets/portal-cards-cancel.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.cards = window.__SP.cards || {};

  function safeStr(v) {
    return typeof v === 'string' ? v : v == null ? '' : String(v);
  }

  function shortId(gid) {
    var s = String(gid || '');
    if (!s) return '';
    var parts = s.split('/');
    return parts[parts.length - 1] || s;
  }

  function buildCancelUrlFallback(contract) {
    try {
      var path = safeStr(window.location.pathname || '');
      var sp = new URLSearchParams(window.location.search || '');

      // Ensure we have an id param
      var id = safeStr(sp.get('id') || '');
      if (!id) {
        id = shortId(contract && contract.id) || safeStr(contract && contract.id);
      }
      if (id) sp.set('id', id);

      sp.set('intent', 'cancel');
      return path + '?' + sp.toString();
    } catch (e) {
      return '';
    }
  }

  window.__SP.cards.cancel = {
    render: function render(ui, contractOrCtx, utilsMaybe, optsMaybe) {
      // Support both call styles:
      //  A) render(ui, contract, utils, opts)
      //  B) render(ui, ctx) where ctx = { contract, isReadOnly, cancelUrl, canCancel, ... }
      var ctx = null;
      var contract = null;
      var opts = null;

      if (contractOrCtx && typeof contractOrCtx === 'object' && contractOrCtx.contract) {
        ctx = contractOrCtx;
        contract = contractOrCtx.contract || null;
        opts = contractOrCtx; // important: treat ctx as opts
      } else {
        ctx = null;
        contract = contractOrCtx || null;
        opts = optsMaybe || {};
      }

      opts = opts || {};
      var isReadOnly = !!opts.isReadOnly;

      // ✅ canCancel can come from:
      // - opts.canCancel (preferred)
      // - ctx.canCancel (when called via safeCardRender("cancel", ui, ctx))
      var canCancelFlag = null;
      if (typeof opts.canCancel === 'boolean') canCancelFlag = opts.canCancel;
      else if (ctx && typeof ctx.canCancel === 'boolean') canCancelFlag = ctx.canCancel;

      var canCancel;
      if (typeof canCancelFlag === 'boolean') {
        canCancel = canCancelFlag && !isReadOnly;
      } else {
        canCancel = !isReadOnly && !!(contract && contract.id);
      }

      // cancelUrl can come from ctx/opts, fallback to current URL + intent=cancel
      var cancelUrl =
        safeStr(opts.cancelUrl) ||
        (ctx ? safeStr(ctx.cancelUrl) : '') ||
        buildCancelUrlFallback(contract);

      var btnAttrs = {
        type: 'button',
        class: 'sp-btn sp-btn--danger',
      };

      if (!canCancel) {
        btnAttrs.class += ' sp-btn--disabled';
        btnAttrs.disabled = true;
      }

      var cancelBtn = ui.el('button', btnAttrs, ['Cancel']);

      if (canCancel) {
        cancelBtn.addEventListener('click', function () {
          if (!cancelUrl) return;

          try {
            var url = new URL(cancelUrl, window.location.origin);

            // Push URL into browser history (no refresh)
            window.history.pushState({}, '', url.pathname + url.search);

            // Trigger router to re-evaluate current route
            window.dispatchEvent(new Event('popstate'));
          } catch (e) {
            // Fallback to hard refresh if something goes wrong
            window.location.href = cancelUrl;
          }
        });
      }

      var card = ui.el('div', { class: 'sp-card sp-detail__cancel' }, [
        ui.el('div', { class: 'sp-detail__cancel-row' }, [
          ui.el('div', {}, [
            ui.el('div', { class: 'sp-detail__cancel-title' }, ['Cancel subscription']),
            ui.el('p', { class: 'sp-muted sp-detail__cancel-sub' }, [
              'We’ll ask a couple quick questions first.',
            ]),
          ]),
          cancelBtn,
        ]),
      ]);

      return { el: card };
    },
  };
})();
