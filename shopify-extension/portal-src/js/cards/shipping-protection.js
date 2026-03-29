// assets/portal-cards-shipping-protection.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.cards = window.__SP.cards || {};

  function getRoot() {
    return document.querySelector(".subscriptions-portal");
  }

  function fmtMoney(n) {
    var x = Number(n);
    if (!isFinite(x)) return "";
    return "$" + x.toFixed(2);
  }

  function lineTitleLower(ln, utils) {
    try {
      var t = utils && utils.safeStr ? utils.safeStr(ln && ln.title) : (ln && ln.title);
      return String(t || "").trim().toLowerCase();
    } catch (e) {
      return "";
    }
  }

  function getAllowedShipProtVariantIdsFromRoot() {
    try {
      var root = getRoot();
      if (!root) return [];
      var raw = root.getAttribute("data-shipping-protection-variant-ids") || "";
      if (!raw) return [];
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr
        .map(function (x) { return Number(x); })
        .filter(function (n) { return isFinite(n) && n > 0; });
    } catch (e) {
      return [];
    }
  }

  // Best-effort parse price from a line item (returns dollars)
  function pickLinePriceDollars(ln) {
    if (!ln) return NaN;

    function unwrapAmount(x) {
      if (x == null) return null;
      if (typeof x === "object") {
        if (x.amount != null) return x.amount;
        if (x.value != null) return x.value;
      }
      return x;
    }

    var candidates = [
      ln && ln.lineDiscountedPrice && ln.lineDiscountedPrice.amount && ln.lineDiscountedPrice.amount.amount,
      ln && ln.lineDiscountedPrice && ln.lineDiscountedPrice.amount,
      ln && ln.currentPrice && ln.currentPrice.amount && ln.currentPrice.amount.amount,
      ln && ln.currentPrice && ln.currentPrice.amount,
      ln && ln.price && ln.price.amount && ln.price.amount.amount,
      ln && ln.price && ln.price.amount,
      ln && ln.discountedPrice && ln.discountedPrice.amount && ln.discountedPrice.amount.amount,
      ln && ln.discountedPrice && ln.discountedPrice.amount,
      ln && ln.linePrice,
      ln && ln.amount,
      ln && ln.price,
    ];

    for (var i = 0; i < candidates.length; i++) {
      var v = unwrapAmount(candidates[i]);
      if (v == null) continue;

      var s = String(v).trim();
      if (!s) continue;

      if (s.indexOf(".") >= 0) {
        var dollars = Number(s);
        if (isFinite(dollars)) return dollars;
        continue;
      }

      var n = Number(s);
      if (!isFinite(n)) continue;

      // heuristic cents
      if (n >= 50) return n / 100;

      // small integer -> assume dollars
      return n;
    }

    return NaN;
  }

  function findShipProtectionLine(contract, utils) {
    var linesAll = (contract && Array.isArray(contract.lines)) ? contract.lines : [];
    var found = null;

    // Requirement #1: title match (case-insensitive)
    for (var i = 0; i < linesAll.length; i++) {
      var ln = linesAll[i];
      if (!ln) continue;
      if (lineTitleLower(ln, utils) === "shipping protection") {
        found = ln;
        break;
      }
    }

    // Fallback: utils detector
    if (!found && utils && typeof utils.isShippingProtectionLine === "function") {
      for (var j = 0; j < linesAll.length; j++) {
        var ln2 = linesAll[j];
        if (!ln2) continue;
        try {
          if (utils.isShippingProtectionLine(ln2)) {
            found = ln2;
            break;
          }
        } catch (e) {}
      }
    }

    return found;
  }

  function sectionTitle(ui, title, sub) {
    return ui.el("div", { class: "sp-detail__sectionhead" }, [
      ui.el("div", { class: "sp-title2" }, [title]),
      sub ? ui.el("p", { class: "sp-muted sp-detail__section-sub" }, [sub]) : ui.el("span", {}, []),
    ]);
  }

  function getActionFn(actions) {
    // Preferred: actions.shippingProtection.toggle
    try {
      if (actions && actions.shippingProtection && typeof actions.shippingProtection.toggle === "function") {
        return actions.shippingProtection.toggle;
      }
    } catch (e) {}

    return null;
  }

  function rerenderDetailScreen() {
    try {
      if (window.__SP &&
          window.__SP.screens &&
          window.__SP.screens.subscriptionDetail &&
          typeof window.__SP.screens.subscriptionDetail.render === "function") {
        window.__SP.screens.subscriptionDetail.render();
      }
    } catch (e) {}
  }

  // usage:
  // window.__SP.cards.shippingProtection.render(ui, { contract, utils, actions, isReadOnly, bucket })
  window.__SP.cards.shippingProtection = {
    render: function render(ui, ctx) {
      ctx = ctx || {};
      var contract = ctx.contract || {};
      var utils = ctx.utils || window.__SP.utils || {};
      var actions = ctx.actions || window.__SP.actions || {};
      var isReadOnly = !!ctx.isReadOnly;
      var bucket = String(ctx.bucket || "");

      var shipProtLine = findShipProtectionLine(contract, utils);
      var shipHas = !!shipProtLine;

      var allowed = getAllowedShipProtVariantIdsFromRoot();
      var isConfigured = allowed.length > 0;

      var actionFn = getActionFn(actions);
      var hasAction = typeof actionFn === "function";

      // Enable rules
      var canToggle = !isReadOnly && hasAction && isConfigured && (bucket !== "cancelled");

      // Pricing
      var onPrice = pickLinePriceDollars(shipProtLine);
      var onPriceText = isFinite(onPrice) ? fmtMoney(onPrice) : "$0.00";

      var listPrice = 5.0;
      var discPrice = listPrice * 0.75;

      var priceRow = shipHas
        ? ui.el("div", { class: "sp-muted sp-shipprot__priceRow" }, [
            ui.el("span", {}, ["Price: "]),
            ui.el("strong", {}, [onPriceText]),
          ])
        : ui.el("div", { class: "sp-muted sp-shipprot__priceRow" }, [
            ui.el("span", {}, ["Price: "]),
            ui.el("span", { class: "sp-shipprot__strike" }, [fmtMoney(listPrice)]),
            ui.el("strong", { class: "sp-shipprot__now" }, [fmtMoney(discPrice)]),
          ]);

      // Toggle markup that matches your CSS (input is hidden, label shows track/thumb)
      var toggleId = "sp_shipprot_" + String(contract && contract.id ? contract.id : "x");

      var inputAttrs = { class: "sp-switch", type: "checkbox", id: toggleId };
      if (shipHas) inputAttrs.checked = true;
      if (!canToggle) inputAttrs.disabled = true;

      var inputEl = ui.el("input", inputAttrs, []);

      var labelAttrs = { class: "sp-switchlabel", for: toggleId };
      if (!canToggle) labelAttrs["aria-disabled"] = "true";

      var labelEl = ui.el("label", labelAttrs, [
        ui.el("span", { class: "sp-switchtrack" }, [
          ui.el("span", { class: "sp-switchthumb" }, []),
        ]),
      ]);

      // Wire handler if enabled
      if (canToggle) {
        inputEl.addEventListener("change", function () {
          try {
            if (inputEl.disabled) return;
          } catch (e) {}

          var nextOn = !!inputEl.checked;

          // lock immediately
          try { inputEl.disabled = true; } catch (e2) {}

          // Call action in a compatible way
          // - If action expects (ui, contractGid, nextOn): great
          // - If action expects (ui, contractGid, nextOn, opts): also supported
          //   (we pass the "new" variant id as a hint if the action wants it)
          var opts = { shippingProtectionVariantId: (allowed.length ? allowed[0] : 0) };

          Promise.resolve()
            .then(function () {
              if (!actionFn) throw new Error("missing_action");
              try {
                if (actionFn.length >= 4) return actionFn(ui, contract.id, nextOn, opts);
              } catch (_) {}
              return actionFn(ui, contract.id, nextOn);
            })
            .then(function () {
              rerenderDetailScreen();
            })
            .catch(function () {
              // revert UI
              try { inputEl.checked = !nextOn; } catch (e3) {}
              rerenderDetailScreen();
            });
        });
      }

      // Hint messaging
      var hintText = "";
      if (!isConfigured) hintText = "Shipping protection is not configured.";
      else if (!hasAction) hintText = "Shipping protection toggle is not loaded. Please refresh.";
      else if (isReadOnly) hintText = "Actions will unlock when available.";
      else if (bucket === "cancelled") hintText = "This subscription can’t be edited right now.";
      else hintText = "Toggle to add or remove shipping protection for your next order.";

      var hintEl = ui.el("p", { class: "sp-muted sp-detail__hint" }, [hintText]);

      return ui.el("div", { class: "sp-card sp-detail__card" }, [
        sectionTitle(ui, "Shipping Protection", "Protect orders from loss or theft during shipping."),
        ui.el("div", { class: "sp-detail__shiprow" }, [
          ui.el("div", { class: "sp-detail__shipmeta" }, [
            ui.el("div", { class: "sp-detail__shipstate" }, [shipHas ? "Currently on" : "Currently off"]),
            ui.el("p", { class: "sp-muted sp-detail__shipsub" }, ["85% of customers choose this."]),
            priceRow,
          ]),
          ui.el("div", { class: "sp-switchwrap" }, [
            inputEl,
            labelEl,
          ]),
        ]),
        hintEl,
      ]);
    },
  };
})();