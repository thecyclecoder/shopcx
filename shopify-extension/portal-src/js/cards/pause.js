// assets/portal-cards-pause.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.cards = window.__SP.cards || {};

  function sectionTitle(ui, title, sub) {
    return ui.el("div", { class: "sp-detail__sectionhead" }, [
      ui.el("div", { class: "sp-title2" }, [title]),
      sub ? ui.el("p", { class: "sp-muted sp-detail__section-sub" }, [sub]) : ui.el("span", {}, []),
    ]);
  }

  function renderAlert(ui, title, body) {
    return ui.el("div", { class: "sp-alert" }, [
      ui.el("div", { class: "sp-alert__title" }, [title]),
      ui.el("div", { class: "sp-alert__body sp-muted" }, [body]),
    ]);
  }

  function disabledBtn(ui, text) {
    return ui.el("button", { type: "button", class: "sp-btn sp-btn--disabled", disabled: true }, [text]);
  }

  function btnProps(isReadOnly, onclick) {
    var p = { type: "button", class: "sp-btn", onclick: onclick };
    if (isReadOnly) {
      p.class += " sp-btn--disabled";
      p.disabled = true; // never set disabled="false"
    }
    return p;
  }

  // Card: Pause
  // usage:
  // window.__SP.cards.pause.render(ui, { contract, actions, isReadOnly, bucket })
  window.__SP.cards.pause = {
    render: function render(ui, ctx) {
      ctx = ctx || {};
      var contract = ctx.contract || {};
      var actions = ctx.actions || window.__SP.actions || {};
      var isReadOnly = !!ctx.isReadOnly;
      var bucket = String(ctx.bucket || ""); // "active" | "paused" | "cancelled" etc.

      // Only show Pause card when NOT paused and NOT cancelled
      if (bucket === "paused") return null;
      if (bucket === "cancelled") {
        return ui.el("div", { class: "sp-card sp-detail__card" }, [
          sectionTitle(ui, "Pause", "This subscription is cancelled."),
          ui.el("p", { class: "sp-muted sp-detail__hint" }, ["Cancelled subscriptions can’t be paused or resumed."]),
        ]);
      }

      var hasPause = typeof actions.pause === "function";

      function onPause(days) {
        if (isReadOnly || !hasPause) return;
        actions.pause(ui, contract.id, Number(days)).then(function () {
          try {
            if (window.__SP.screens && window.__SP.screens.subscriptionDetail && typeof window.__SP.screens.subscriptionDetail.render === "function") {
              window.__SP.screens.subscriptionDetail.render();
            }
          } catch (e) {}
        });
      }

      // If pause action missing, show a clear alert (helps debugging import order)
      if (!hasPause) {
        return ui.el("div", { class: "sp-card sp-detail__card" }, [
          sectionTitle(ui, "Pause", "Pause pushes your next order out from today."),
          renderAlert(ui, "Pause unavailable", "Pause action is not loaded. Please refresh."),
        ]);
      }

      return ui.el("div", { class: "sp-card sp-detail__card" }, [
        sectionTitle(ui, "Pause", "Pause pushes your next order out from today."),
        ui.el("div", { class: "sp-detail__actions" }, [
          ui.el("button", btnProps(isReadOnly, function () { onPause(30); }), ["Pause 30 days"]),
          ui.el("button", btnProps(isReadOnly, function () { onPause(60); }), ["Pause 60 days"]),
        ]),
        ui.el("p", { class: "sp-muted sp-detail__hint" }, [
          isReadOnly ? "Actions will unlock when available." : "Subscription will resume after the selected period ends.",
        ]),
      ]);
    },
  };
})();