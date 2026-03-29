// assets/portal-cards-resume.js
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

  function btnProps(isReadOnly, onclick) {
    var p = { type: "button", class: "sp-btn", onclick: onclick };
    if (isReadOnly) {
      p.class += " sp-btn--disabled";
      p.disabled = true; // never set disabled="false"
    }
    return p;
  }

  // Card: Resume
  // usage:
  // window.__SP.cards.resume.render(ui, { contract, actions, isReadOnly, bucket })
  window.__SP.cards.resume = {
    render: function render(ui, ctx) {
      ctx = ctx || {};
      var contract = ctx.contract || {};
      var actions = ctx.actions || window.__SP.actions || {};
      var isReadOnly = !!ctx.isReadOnly;
      var bucket = String(ctx.bucket || "");

      // Only show Resume card when paused
      if (bucket !== "paused") return null;

      var hasResume = typeof actions.resume === "function";

      function onResume() {
        if (isReadOnly || !hasResume) return;
        actions.resume(ui, contract.id, 1).then(function () {
          try {
            if (window.__SP.screens && window.__SP.screens.subscriptionDetail && typeof window.__SP.screens.subscriptionDetail.render === "function") {
              window.__SP.screens.subscriptionDetail.render();
            }
          } catch (e) {}
        });
      }

      if (!hasResume) {
        return ui.el("div", { class: "sp-card sp-detail__card" }, [
          sectionTitle(ui, "Resume", "Restart your subscription when you are ready."),
          renderAlert(ui, "Resume unavailable", "Resume action is not loaded. Please refresh."),
        ]);
      }

      var base = btnProps(isReadOnly, onResume);
      base.class = base.class + " sp-btn--full";

      return ui.el("div", { class: "sp-card sp-detail__card" }, [
        sectionTitle(ui, "Resume", "Restart your subscription when you are ready."),
        ui.el("p", { class: "sp-muted sp-detail__hint" }, [
          "Resuming sets your next order to tomorrow, so you can review and make changes before it is placed.",
        ]),
        ui.el("div", { class: "sp-detail__actions sp-detail__actions--stack" }, [
          ui.el("button", base, ["Resume subscription"]),
        ]),
      ]);
    },
  };
})();