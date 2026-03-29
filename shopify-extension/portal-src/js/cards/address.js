// cards/address.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.cards = window.__SP.cards || {};

  function safeStr(v) {
    return typeof v === "string" ? v : v == null ? "" : String(v);
  }

  function sectionTitle(ui, title, sub) {
    return ui.el("div", { class: "sp-detail__sectionhead" }, [
      ui.el("div", { class: "sp-title2" }, [title]),
      sub ? ui.el("p", { class: "sp-muted sp-detail__section-sub" }, [sub]) : ui.el("span", {}, []),
    ]);
  }

  function pickContractAddress(contract) {
    try {
      var addr = (contract && contract.deliveryMethod && contract.deliveryMethod.address) || null;
      return addr && typeof addr === "object" ? addr : null;
    } catch (e) {
      return null;
    }
  }

  // IMPORTANT: address2 on its own line (prevents orphans)
  function formatAddressLines(addr) {
    addr = addr || {};

    var first = safeStr(addr.firstName).trim();
    var last = safeStr(addr.lastName).trim();
    var name = [first, last].filter(Boolean).join(" ");

    var a1 = safeStr(addr.address1).trim();
    var a2 = safeStr(addr.address2).trim();

    var city = safeStr(addr.city).trim();
    var prov = safeStr(addr.provinceCode || addr.province).trim();
    var zip = safeStr(addr.zip || addr.postalCode).trim();
    var line2 = [city, prov, zip].filter(Boolean).join(" ");

    var country = safeStr(addr.country || addr.countryName).trim();

    var out = [];
    if (name) out.push(name);
    if (a1) out.push(a1);
    if (a2) out.push(a2); // <- line 2 forced new line
    if (line2) out.push(line2);
    if (country && country.toLowerCase() !== "united states" && country.toLowerCase() !== "us") out.push(country);

    return out;
  }

  function renderAddressBlock(ui, addr) {
    var lines = formatAddressLines(addr);
    if (!lines.length) {
      return ui.el("div", { class: "sp-muted" }, ["Shipping address not available."]);
    }

    return ui.el("div", { class: "sp-card", style: "padding:14px; border-radius:16px; background:#fff;" }, [
      ui.el("div", { class: "sp-title2", style: "font-size:14px; margin:0 0 8px 0;" }, ["Current shipping address"]),
      ui.el("div", { class: "sp-muted", style: "line-height:1.45;" }, [
        ui.el("div", {}, [lines[0] || ""]),
        lines[1] ? ui.el("div", {}, [lines[1]]) : ui.el("span", {}, []),
        lines[2] ? ui.el("div", {}, [lines[2]]) : ui.el("span", {}, []),
        lines[3] ? ui.el("div", {}, [lines[3]]) : ui.el("span", {}, []),
        lines[4] ? ui.el("div", {}, [lines[4]]) : ui.el("span", {}, []),
      ]),
    ]);
  }

  // Card: Shipping Address
  // usage:
  // window.__SP.cards.address.render(ui, { contract, actions, isReadOnly })
  window.__SP.cards.address = {
    render: function render(ui, ctx) {
      ctx = ctx || {};
      var contract = ctx.contract || {};
      var actions = ctx.actions || window.__SP.actions || {};
      var isReadOnly = !!ctx.isReadOnly;

      var hasChangeShipping = typeof actions.changeShippingAddress === "function";

      function onChangeShipping() {
        if (isReadOnly || !hasChangeShipping) return;
        var addr = pickContractAddress(contract) || {};
        var defaults = {
          countryCode: safeStr(addr.countryCode || addr.country_code || "US"),
          country: safeStr(addr.country || "United States"),
          methodType: "Economy",
        };
        actions.changeShippingAddress(ui, contract.id, addr, defaults);
      }

      var currentAddr = pickContractAddress(contract);
      var addressBlock = renderAddressBlock(ui, currentAddr);

      var changeBtnProps = { type: "button", class: "sp-btn" };
      if (isReadOnly) {
        changeBtnProps.class += " sp-btn--disabled";
        changeBtnProps.disabled = true;
      } else if (hasChangeShipping) {
        changeBtnProps.onclick = onChangeShipping;
      } else {
        changeBtnProps.class += " sp-btn--disabled";
        changeBtnProps.disabled = true;
      }

      return ui.el("div", { class: "sp-card sp-detail__card" }, [
        sectionTitle(ui, "Shipping", "Update where your next order ships."),
        ui.el("div", { style: "margin-top:10px;" }, [addressBlock]),
        ui.el("div", { class: "sp-detail__actions sp-detail__actions--stack", style: "margin-top:12px;" }, [
          ui.el("button", changeBtnProps, ["Change shipping address"]),
          ui.el(
            "a",
            { class: "sp-btn sp-btn--ghost", href: "https://account.superfoodscompany.com/orders", target: "_blank", rel: "noopener" },
            ["View recent orders"]
          ),
        ]),
        ui.el("p", { class: "sp-muted sp-detail__hint" }, [
          isReadOnly ? "Actions will unlock when available." : "Click to edit your address for upcoming orders.",
        ]),
      ]);
    },
  };
})();