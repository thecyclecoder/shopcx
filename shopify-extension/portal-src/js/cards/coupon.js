// cards/coupon.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.cards = window.__SP.cards || {};

  function sectionTitle(ui, title, sub) {
    return ui.el("div", { class: "sp-detail__sectionhead" }, [
      ui.el("div", { class: "sp-title2" }, [title]),
      sub ? ui.el("p", { class: "sp-muted sp-detail__section-sub" }, [sub]) : ui.el("span", {}, []),
    ]);
  }

  function s(v) {
    return typeof v === "string" ? v.trim() : "";
  }

  function safeText(v, fallback) {
    if (typeof v === "string" && v) return v;
    if (v == null) return fallback || "";
    return String(v);
  }

  function getContractFromCtx(ctx) {
    return (
      (ctx && ctx.contract) ||
      (ctx && ctx.subscription) ||
      (ctx && ctx.data && ctx.data.contract) ||
      (ctx && ctx.data && ctx.data.subscription) ||
      null
    );
  }

  function getDiscountNodes(contract) {
    var d = contract && contract.discounts;
    if (!d) return [];

    if (Array.isArray(d)) return d;
    if (d && Array.isArray(d.nodes)) return d.nodes;

    if (d && Array.isArray(d.edges)) {
      var out = [];
      for (var i = 0; i < d.edges.length; i++) {
        var n = d.edges[i] && d.edges[i].node;
        if (n) out.push(n);
      }
      return out;
    }

    return [];
  }

  function pickDiscountDisplay(discount) {
    var code = discount && (discount.code || discount.discountCode || discount.couponCode);
    var title = discount && (discount.title || discount.name || discount.label);
    return safeText(code || title, "Discount");
  }

  function pickDiscountId(discount) {
    return s(discount && discount.id);
  }

  function showToast(ui, msg, type) {
    try {
      var busy = window.__SP && window.__SP.actions && window.__SP.actions.busy;
      if (busy && typeof busy.showToast === "function") {
        busy.showToast(ui, msg, type || "success");
        return;
      }
    } catch (e) {}
  }

  async function callCouponAction(ui, payload) {
    var act = window.__SP && window.__SP.actions && window.__SP.actions.coupon;
    if (!act) return null;

    if (typeof act.run === "function") return await act.run(ui, payload);
    if (typeof act.submit === "function") return await act.submit(ui, payload);

    if (payload && payload.mode === "apply" && typeof act.apply === "function") {
      return await act.apply(ui, payload.contractId, payload.discountCode);
    }
    if (payload && payload.mode === "remove" && typeof act.remove === "function") {
      return await act.remove(ui, payload.contractId, payload.discountId);
    }

    return null;
  }

  window.__SP.cards.coupon = {
    render: function render(ui, ctx) {
      ctx = ctx || {};
      var contract = getContractFromCtx(ctx);
      var isReadOnly = !!ctx.isReadOnly;

      var discounts = contract ? getDiscountNodes(contract) : [];
      var active = discounts && discounts.length ? discounts[0] : null;
      var activeId = active ? pickDiscountId(active) : "";
      var activeLabel = active ? pickDiscountDisplay(active) : "";

      var inFlight = false;

      // Input attrs: omit disabled when allowed
      var inputAttrs = {
        class: "sp-input",
        type: "text",
        placeholder: "Enter coupon code",
        "aria-label": "Coupon code",
      };
      if (isReadOnly || activeId) inputAttrs.disabled = true;

      var inputEl = ui.el("input", inputAttrs, []);

      var applyAttrs = {
        type: "button",
        class: "sp-btn",
        onclick: async function () {
          if (isReadOnly) return;
          if (activeId) return;
          if (inFlight) return;

          var code = s(inputEl && inputEl.value);
          if (!code) {
            showToast(ui, "Enter a coupon code.", "error");
            return;
          }

          inFlight = true;
          try {
            var res = await callCouponAction(ui, {
              mode: "apply",
              contractId: (contract && contract.id) ? contract.id : ctx.contractId,
              discountCode: code,
            });

            if (!res) {
              showToast(ui, "Coupon action is not wired yet.", "error");
              // Clear so they don’t spam the same thing blindly
              try { inputEl.value = ""; } catch (_) {}
              return;
            }

            if (!res.ok) {
              // Clear the field on any failure (invalid/expired/etc.)
              try { inputEl.value = ""; } catch (_) {}
              return;
            }

            // success: (screen will re-render)
          } finally {
            inFlight = false;
          }
        },
      };
      if (isReadOnly || activeId) {
        applyAttrs.disabled = true;
        applyAttrs.class += " sp-btn--disabled";
      }

      var applyBtn = ui.el("button", applyAttrs, ["Apply"]);

      var removeAttrs = {
        type: "button",
        class: "sp-btn sp-btn--ghost",
        onclick: async function () {
          if (isReadOnly) return;
          if (!activeId) return;
          if (inFlight) return;

          inFlight = true;
          try {
            var res = await callCouponAction(ui, {
              mode: "remove",
              contractId: (contract && contract.id) ? contract.id : ctx.contractId,
              discountId: activeId,
            });

            if (!res) {
              showToast(ui, "Coupon action is not wired yet.", "error");
              return;
            }

            // on failure: toast handled by action
            return;
          } finally {
            inFlight = false;
          }
        },
      };
      if (isReadOnly) {
        removeAttrs.disabled = true;
        removeAttrs.class += " sp-btn--disabled";
      }

      var removeBtn = ui.el("button", removeAttrs, ["Remove"]);

      var body = [];

      if (activeId) {
        body.push(
          ui.el("div", { class: "sp-detail__coupon" }, [
            ui.el("div", { class: "sp-detail__coupon-applied" }, [
              ui.el("div", { class: "sp-title3" }, ["Applied"]),
              ui.el("div", { class: "sp-muted" }, [activeLabel]),
            ]),
            removeBtn,
          ])
        );

        body.push(
          ui.el("p", { class: "sp-muted sp-detail__hint" }, [
            "This coupon will be applied to future subscription orders.",
          ])
        );

        if (discounts.length > 1) {
          body.push(
            ui.el("p", { class: "sp-muted sp-detail__hint" }, [
              "Multiple discounts are present on this subscription. Only one can be managed in the portal. Showing the first.",
            ])
          );
        }
      } else {
        body.push(ui.el("div", { class: "sp-detail__coupon" }, [inputEl, applyBtn]));
        body.push(
          ui.el("p", { class: "sp-muted sp-detail__hint" }, [
            "Only one coupon can be active on a subscription at a time.",
          ])
        );
      }

      return ui.el("div", { class: "sp-card sp-detail__card" }, [
        sectionTitle(ui, "Coupon", "Apply a discount code to future subscription orders."),
        ui.el("div", { class: "sp-detail__couponwrap" }, body),
      ]);
    },
  };
})();