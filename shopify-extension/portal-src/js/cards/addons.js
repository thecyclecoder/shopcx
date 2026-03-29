// assets/portal-cards-addons.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.cards = window.__SP.cards || {};

  function sectionTitle(ui, title, sub) {
    return ui.el("div", { class: "sp-detail__sectionhead" }, [
      ui.el("div", { class: "sp-title2" }, [title]),
      sub ? ui.el("p", { class: "sp-muted sp-detail__section-sub" }, [sub]) : ui.el("span", {}, []),
    ]);
  }

  /**
   * Card: One-time add-ons (placeholder for now)
   *
   * Usage:
   *   var card = window.__SP.cards.addons.render(ui, contract, utils, { isReadOnly: true/false })
   * Returns: { el }
   */
  window.__SP.cards.addons = {
    render: function render(ui /*, contract, utils*/, opts) {
      opts = opts || {};
      var isReadOnly = !!opts.isReadOnly;

      var card = ui.el("div", { class: "sp-card sp-detail__card" }, [
        sectionTitle(ui, "One-time add-ons", "Add to your next order (one-time only)."),
        ui.el("div", { class: "sp-detail__addons" }, [
          ui.el("div", { class: "sp-addon sp-addon--disabled" }, [
            ui.el("div", { class: "sp-addon__title" }, ["Add-on products will show here"]),
            ui.el("div", { class: "sp-muted sp-addon__sub" }, ["(Not wired yet)"]),
          ]),
        ]),
        ui.el("p", { class: "sp-muted sp-detail__hint" }, [
          isReadOnly ? "Actions will unlock when available." : "Coming next.",
        ]),
      ]);

      return { el: card };
    },
  };
})();