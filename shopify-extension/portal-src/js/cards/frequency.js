// assets/portal-cards-frequency.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.cards = window.__SP.cards || {};

  function sectionTitle(ui, title, sub) {
    return ui.el('div', { class: 'sp-detail__sectionhead' }, [
      ui.el('div', { class: 'sp-title2' }, [title]),
      sub ? ui.el('p', { class: 'sp-muted sp-detail__section-sub' }, [sub]) : ui.el('span', {}, []),
    ]);
  }

  function s(v) {
    return typeof v === 'string' ? v.trim() : '';
  }

  function toNum(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback == null ? 0 : fallback;
  }

  function normInterval(v) {
    var x = s(v).toUpperCase();
    if (!x || x === '$UNKNOWN') return '';
    return x;
  }

  function mapToDisplayLabel(interval, intervalCount) {
    var i = normInterval(interval);
    var c = toNum(intervalCount, 0);

    if (i === 'WEEK') {
      if (c === 4) return 'Monthly';
      if (c === 8) return 'Every 2 Months';
      if (c === 2) return 'Every 2 Weeks';
      return c > 0 ? 'Every ' + c + ' Weeks' : '';
    }

    if (i === 'MONTH') {
      if (c === 1) return 'Monthly';
      if (c === 2) return 'Every 2 Months';
      return c > 0 ? 'Every ' + c + ' Months' : '';
    }

    return '';
  }

  function getCurrentFromBillingPolicy(contract) {
    try {
      var bp = contract && contract.billingPolicy;
      if (!bp || typeof bp !== 'object') return null;

      var interval = normInterval(bp.interval);

      // Primary field name is intervalCount. Keep defensive fallbacks.
      var intervalCount =
        (bp.intervalCount != null ? bp.intervalCount : null) ||
        (bp.invervalCount != null ? bp.invervalCount : null) ||
        0;

      var c = toNum(intervalCount, 0);
      if (!interval || !c) return null;

      return { interval: interval, intervalCount: c };
    } catch (e) {
      return null;
    }
  }

  function disabledBtn(ui, text) {
    return ui.el('button', { type: 'button', class: 'sp-btn sp-btn--disabled', disabled: true }, [
      text,
    ]);
  }

  function enabledBtn(ui, text, onClick) {
    var btn = ui.el('button', { type: 'button', class: 'sp-btn' }, [text]);
    if (typeof onClick === 'function') btn.addEventListener('click', onClick);
    return btn;
  }

  // ---------------------------------------------------------------------------
  // Modal (radio + submit/cancel)
  // Calls: ctx.actions.frequency.update(ui, contractGid, { deliveryInterval, deliveryIntervalCount })
  // ---------------------------------------------------------------------------

  function openFrequencyModal(ui, ctx, currentSel) {
    ctx = ctx || {};
    var actions = ctx.actions || window.__SP.actions || {};
    var busy = actions.busy;

    // Overlay
    var modalRoot = ui.el('div', { class: 'sp-modal' }, []);
    document.body.classList.add('sp-modal-open');

    // Card
    var card = ui.el('div', { class: 'sp-modal__card' }, []);

    // Title
    var title = ui.el('div', { class: 'sp-modal__title' }, ['Change frequency']);

    var options = [
      { id: 'freq_2w', label: 'Every 2 Weeks', interval: 'WEEK', intervalCount: 2 },
      { id: 'freq_4w', label: 'Monthly', interval: 'WEEK', intervalCount: 4 },
      { id: 'freq_8w', label: 'Every 2 Months', interval: 'WEEK', intervalCount: 8 },
    ];

    var selected = {
      interval: normInterval(currentSel && currentSel.interval) || 'WEEK',
      intervalCount: toNum(currentSel && currentSel.intervalCount, 4) || 4,
    };

    function isSelected(opt) {
      return selected.interval === opt.interval && selected.intervalCount === opt.intervalCount;
    }

    function radioRow(opt) {
      var input = ui.el('input', {
        type: 'radio',
        name: 'sp_freq_choice',
        value: opt.id,
        checked: isSelected(opt) ? true : undefined,
      });

      var row = ui.el('label', { class: 'sp-radio-row' }, [
        input,
        ui.el('span', { class: 'sp-radio-row__label' }, [opt.label]),
      ]);

      row.addEventListener('click', function () {
        selected.interval = opt.interval;
        selected.intervalCount = opt.intervalCount;

        try {
          var inputs = card.querySelectorAll('input[name="sp_freq_choice"]');
          for (var i = 0; i < inputs.length; i++) {
            inputs[i].checked = inputs[i].value === opt.id;
          }
        } catch (e) {}
      });

      return row;
    }

    // Body (scrollable)
    var body = ui.el('div', { class: 'sp-modal__body' }, [
      ui.el('p', { class: 'sp-muted' }, ['Choose how often you want this subscription delivered.']),
      ui.el('div', { class: 'sp-radio-list' }, options.map(radioRow)),
    ]);

    function close() {
      try {
        modalRoot.remove();
      } catch (e) {}
      document.body.classList.remove('sp-modal-open');
    }

    // Footer
    var btnCancel = ui.el('button', { type: 'button', class: 'sp-btn sp-btn--secondary' }, [
      'Cancel',
    ]);
    btnCancel.addEventListener('click', close);

    var btnSave = ui.el('button', { type: 'button', class: 'sp-btn' }, ['Submit']);

    btnSave.addEventListener('click', async function () {
      try {
        var contract = ctx.contract;
        var contractGid = contract && contract.id ? String(contract.id) : '';
        if (!contractGid) throw new Error('missing_contract_id');

        var freqActions =
          actions.frequency || (window.__SP.actions && window.__SP.actions.frequency);

        if (!freqActions || typeof freqActions.update !== 'function') {
          if (busy && typeof busy.showToast === 'function') {
            busy.showToast(ui, 'Frequency action is not wired yet.', 'error');
          }
          return;
        }

        await freqActions.update(ui, contractGid, {
          deliveryInterval: selected.interval,
          deliveryIntervalCount: selected.intervalCount,
        });

        close();
      } catch (e) {
        // action handles toast
      }
    });

    var footer = ui.el('div', { class: 'sp-modal__footer' }, [btnCancel, btnSave]);

    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(footer);
    modalRoot.appendChild(card);

    modalRoot.addEventListener('click', function (e) {
      if (e.target === modalRoot) close();
    });

    document.body.appendChild(modalRoot);
  }

  // ---------------------------------------------------------------------------
  // ctx-based render
  // Called as: safeCardRender("frequency", ui, cardCtx)
  // So signature must be (ui, ctx)
  // ---------------------------------------------------------------------------

  window.__SP.cards.frequency = {
    render: function render(ui, ctx) {
      ctx = ctx || {};
      var contract = ctx.contract;
      var isReadOnly = !!ctx.isReadOnly;

      var cur = getCurrentFromBillingPolicy(contract);
      var label = cur ? mapToDisplayLabel(cur.interval, cur.intervalCount) : '';

      var canChange = !isReadOnly && !!(contract && contract.id);

      function onChange() {
        var sel =
          cur && mapToDisplayLabel(cur.interval, cur.intervalCount)
            ? { interval: cur.interval, intervalCount: cur.intervalCount }
            : { interval: 'WEEK', intervalCount: 4 };

        openFrequencyModal(ui, ctx, sel);
      }

      return ui.el('div', { class: 'sp-card sp-detail__card' }, [
        sectionTitle(ui, 'Your Schedule', 'How often your superfoods are sent.'),
        ui.el('div', { class: 'sp-detail__freq' }, [
          ui.el('div', { class: 'sp-detail__freq-value' }, [
            label ? 'Currently: ' + label : 'Billing frequency not available.',
          ]),
        ]),
        ui.el('div', { class: 'sp-detail__actions sp-detail__actions--stack' }, [
          canChange
            ? enabledBtn(ui, 'Change frequency', onChange)
            : disabledBtn(ui, 'Change frequency'),
        ]),
        ui.el('p', { class: 'sp-muted sp-detail__hint' }, [
          canChange
            ? 'Choose how often you want deliveries.'
            : isReadOnly
              ? 'Actions will unlock when available.'
              : 'Changing delivery frequency is coming next.',
        ]),
      ]);
    },
  };
})();
