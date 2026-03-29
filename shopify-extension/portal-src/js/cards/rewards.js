// assets/cards/rewards.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.cards = window.__SP.cards || {};

  function sectionTitle(ui, title, sub) {
    return ui.el('div', { class: 'sp-detail__sectionhead' }, [
      ui.el('div', { class: 'sp-title2' }, [title]),
      sub ? ui.el('p', { class: 'sp-muted sp-detail__section-sub' }, [sub]) : ui.el('span', {}, []),
    ]);
  }

  function openRewardsFallback() {
    try {
      window.location.href = 'https://superfoodscompany.com/pages/rewards';
    } catch (e) {}
  }

  function openSmileOrFallback() {
    try {
      if (window.SmileUI && typeof window.SmileUI.openPanel === 'function') {
        window.SmileUI.openPanel();
        return;
      }
    } catch (e) {}
    openRewardsFallback();
  }

  window.__SP.cards.rewards = {
    render: function render(ui /*, ctx */) {
      var btn = ui.el(
        'button',
        {
          type: 'button',
          class: 'sp-btn sp-btn--primary sp-rewards__cta',
        },
        ['🎉 View My Points']
      );

      btn.addEventListener('click', function () {
        openSmileOrFallback();
      });

      var banner = ui.el('div', { class: 'sp-rewards__banner' }, [
        ui.el('div', { class: 'sp-rewards__banner-icon', 'aria-hidden': 'true' }, ['✨']),
        ui.el('div', { class: 'sp-rewards__banner-text' }, [
          ui.el('div', { class: 'sp-rewards__banner-title' }, ['You’ve got rewards waiting']),
          ui.el('div', { class: 'sp-rewards__banner-sub sp-muted' }, [
            'Redeem points for coupons and apply them to your subscription.',
          ]),
        ]),
        ui.el('div', { class: 'sp-rewards__pill' }, ['Save on your next order']),
      ]);

      return ui.el('div', { class: 'sp-card sp-detail__card sp-rewards' }, [
        sectionTitle(ui, 'Rewards', 'Your points and perks.'),
        banner,
        ui.el(
          'div',
          { class: 'sp-detail__actions sp-detail__actions--stack sp-rewards__actions' },
          [
            btn,
            ui.el('div', { class: 'sp-rewards__helper sp-muted' }, [
              'Tip: applying a coupon here can reduce your next subscription charge instantly.',
            ]),
          ]
        ),
      ]);
    },
  };
})();
