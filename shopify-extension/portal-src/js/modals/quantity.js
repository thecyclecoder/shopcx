// portal-src/modals/quantity.js
// Modal for "Change quantity" on an existing subscription line.
//
// Requirements:
// - Looks like Step 2 of add-swap modal (same card + note styling).
// - No flavor selector; show the current flavor (title + variantTitle + image).
// - Quantity select (1/2/3) defaults to the CURRENT quantity on the line (not 2).
// - Buttons: Submit + Cancel.
// - If user submits without changing quantity, show success toast and DO NOT call network.
//
// Optional support:
// - opts.catalog (same DOM catalog used by add-swap) so we can show MSRP + discounted price.
// - opts.computePrice({ variant, qty, context }) -> { msrpCents, priceCents, note? } (same as add-swap)
// - If computePrice is not provided, falls back to internal pricing using catalog msrp/price with 25% off.

(function () {
  window.__SP = window.__SP || {};
  window.__SP.modals = window.__SP.modals || {};

  function safeStr(v) {
    return typeof v === "string" ? v : v == null ? "" : String(v);
  }

  function toInt(v, fallback) {
    var n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : (fallback == null ? 0 : fallback);
  }

  function toNum(v, fallback) {
    var n = Number(v);
    return Number.isFinite(n) ? n : (fallback == null ? null : fallback);
  }

  function shortId(gid) {
    var s = String(gid || "");
    if (!s) return "";
    var parts = s.split("/");
    return parts[parts.length - 1] || s;
  }

  function roundCents(x) {
    return Math.round(Number(x) || 0);
  }

  function formatMoneyFromCents(cents) {
    var n = toInt(cents, 0);
    var sign = n < 0 ? "-" : "";
    n = Math.abs(n);
    var dollars = Math.floor(n / 100);
    var rem = n % 100;
    var rem2 = rem < 10 ? "0" + String(rem) : String(rem);
    return sign + "$" + String(dollars) + "." + rem2;
  }

  function parseMoneyToCents(v) {
    if (v == null) return null;
    if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);

    var s = safeStr(v).trim();
    if (!s) return null;

    s = s.replace(/[$,]/g, "").trim();
    var n = Number(s);
    if (!Number.isFinite(n)) return null;

    if (s.indexOf(".") !== -1 || n < 1000) return Math.round(n * 100);
    return Math.trunc(n);
  }

  function isPlainObject(x) {
    return !!x && typeof x === "object" && !Array.isArray(x);
  }

  function pickScalar(v) {
    if (v == null) return "";
    if (typeof v === "string") return v.trim();
    if (typeof v === "number" || typeof v === "boolean") return String(v);

    if (isPlainObject(v)) {
      if (v.value != null) return pickScalar(v.value);
      if (v.stringValue != null) return pickScalar(v.stringValue);
      if (v.text != null) return pickScalar(v.text);
      if (v.label != null) return pickScalar(v.label);

      if (v.url != null) return pickScalar(v.url);
      if (v.src != null) return pickScalar(v.src);
      if (v.transformedSrc != null) return pickScalar(v.transformedSrc);
      if (v.originalSrc != null) return pickScalar(v.originalSrc);

      if (v.previewImage && isPlainObject(v.previewImage)) {
        var a =
          pickScalar(v.previewImage.url) ||
          pickScalar(v.previewImage.src) ||
          pickScalar(v.previewImage.transformedSrc);
        if (a) return a;
      }
    }

    return "";
  }

  function isProbablyUrl(s) {
    s = safeStr(s).trim();
    if (!s) return false;
    if (s.indexOf("[object") === 0) return false;
    return (
      s.indexOf("http://") === 0 ||
      s.indexOf("https://") === 0 ||
      s.indexOf("//") === 0 ||
      s.indexOf("cdn.shopify.com") !== -1
    );
  }

  function pickImageUrl(obj) {
    var url =
      pickScalar(obj && obj.imageUrl) ||
      pickScalar(obj && obj.image) ||
      pickScalar(obj && obj.featuredImage) ||
      pickScalar(obj && obj.featured_image) ||
      pickScalar(obj && obj.featuredMedia) ||
      "";

    if (!url) {
      try {
        var nested =
          (obj && obj.image && (obj.image.src || obj.image.url || obj.image.transformedSrc)) ||
          (obj && obj.featuredImage && (obj.featuredImage.src || obj.featuredImage.url || obj.featuredImage.transformedSrc)) ||
          (obj && obj.featured_image && (obj.featured_image.src || obj.featured_image.url || obj.featured_image.transformedSrc)) ||
          (obj && obj.variantImage && (obj.variantImage.transformedSrc || obj.variantImage.src || obj.variantImage.url)) ||
          "";
        url = pickScalar(nested);
      } catch (e) {}
    }

    url = safeStr(url).trim();
    return isProbablyUrl(url) ? url : "";
  }

  function pickVariantPriceCents(rawV) {
    if (!rawV) return null;

    var c =
      (typeof rawV.priceCents === "number" ? rawV.priceCents : null) ||
      (typeof rawV.price_cents === "number" ? rawV.price_cents : null) ||
      (typeof rawV.price_cent === "number" ? rawV.price_cent : null);

    if (Number.isFinite(c)) return Math.trunc(c);

    var s =
      pickScalar(rawV.price) ||
      pickScalar(rawV.price_amount) ||
      pickScalar(rawV.priceAmount) ||
      pickScalar(rawV.unitPrice) ||
      "";

    var parsed = parseMoneyToCents(s);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function pickVariantMsrpCents(rawV) {
    if (!rawV) return null;

    var c =
      (typeof rawV.msrpCents === "number" ? rawV.msrpCents : null) ||
      (typeof rawV.compareAtPriceCents === "number" ? rawV.compareAtPriceCents : null) ||
      (typeof rawV.compare_at_price_cents === "number" ? rawV.compare_at_price_cents : null) ||
      (typeof rawV.compare_at_price_cent === "number" ? rawV.compare_at_price_cent : null);

    if (Number.isFinite(c)) return Math.trunc(c);

    var s =
      pickScalar(rawV.compare_at_price) ||
      pickScalar(rawV.compareAtPrice) ||
      pickScalar(rawV.msrp) ||
      "";

    var parsed = parseMoneyToCents(s);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function getVariantId(v) {
    var id = (v && (v.variantId != null ? v.variantId : v.id));
    return pickScalar(id) || safeStr(id);
  }

  function normalizeVariant(rawV) {
    if (!rawV) return null;

    var out = {
      variantId: getVariantId(rawV),
      title: safeStr(pickScalar(rawV.title) || rawV.title).trim(),
      imageUrl: pickImageUrl(rawV),
      _raw: rawV,
    };

    var msrp = pickVariantMsrpCents(rawV);
    var price = pickVariantPriceCents(rawV);

    if (Number.isFinite(msrp)) out.msrpCents = msrp;
    if (Number.isFinite(price)) out.priceCents = price;

    return out.variantId ? out : null;
  }

  function normalizeCatalog(catalog) {
    var arr = Array.isArray(catalog) ? catalog.filter(Boolean) : [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var p = arr[i];
      if (!p) continue;

      var rawVs = (p && Array.isArray(p.variants)) ? p.variants : [];
      for (var j = 0; j < rawVs.length; j++) {
        var nv = normalizeVariant(rawVs[j]);
        if (nv) out.push(nv);
      }
    }
    return out;
  }

  function findVariantFromCatalog(catalogRaw, lineVariantGid) {
    var lineShort = safeStr(shortId(lineVariantGid));
    if (!lineShort) return null;

    var flat = normalizeCatalog(catalogRaw);
    for (var i = 0; i < flat.length; i++) {
      var v = flat[i];
      if (!v) continue;
      if (safeStr(v.variantId) === lineShort) return v;
    }
    return null;
  }

  function ensureBodyNoScroll(on) {
    try {
      if (on) document.body.classList.add("sp-modal-open");
      else document.body.classList.remove("sp-modal-open");
    } catch (e) {}
  }

  function closeModal(state) {
    try {
      if (state && state.root && state.root.parentNode) state.root.parentNode.removeChild(state.root);
    } catch (e) {}
    ensureBodyNoScroll(false);
  }

  function showToast(ui, msg, type) {
    try {
      var busy = window.__SP.actions && window.__SP.actions.busy;
      if (busy && typeof busy.showToast === "function") {
        busy.showToast(ui, msg, type || "success");
        return;
      }
    } catch (e) {}
    try { console.log("[toast]", type || "info", msg); } catch (e2) {}
  }

  function renderPriceRow(ui, msrpCents, priceCents, noteText) {
    var hasMsrp = Number.isFinite(msrpCents) && msrpCents > 0;
    var hasPrice = Number.isFinite(priceCents);

    return ui.el("div", { class: "sp-addswap-price" }, [
      ui.el("div", { class: "sp-addswap-price__label sp-muted" }, ["Price"]),
      ui.el("div", { class: "sp-addswap-price__vals" }, [
        hasMsrp ? ui.el("div", { class: "sp-addswap-price__msrp" }, [formatMoneyFromCents(msrpCents)]) : ui.el("span", {}, []),
        hasPrice ? ui.el("div", { class: "sp-addswap-price__now" }, [formatMoneyFromCents(priceCents)]) : ui.el("div", { class: "sp-addswap-price__dash sp-muted" }, ["—"]),
      ]),
      noteText ? ui.el("div", { class: "sp-addswap-price__note sp-muted" }, [noteText]) : ui.el("span", {}, []),
    ]);
  }

  function computeDisplayedPrice(variant, qty, computePrice, context) {
    qty = toInt(qty, 1) || 1;

    if (computePrice && typeof computePrice === "function") {
      try {
        var out = computePrice({ variant: variant, qty: qty, context: context }) || {};
        if (Number.isFinite(out.msrpCents) || Number.isFinite(out.priceCents)) {
          return {
            msrpCents: Number.isFinite(out.msrpCents) ? out.msrpCents : null,
            priceCents: Number.isFinite(out.priceCents) ? out.priceCents : null,
            note: safeStr(out.note || ""),
          };
        }
      } catch (e0) {}
    }

    // Default internal pricing (simple: 25% subscribe & save off "base")
    var unitMsrp = variant && Number.isFinite(variant.msrpCents) ? variant.msrpCents : null;
    var unitBase = variant && Number.isFinite(variant.priceCents) ? variant.priceCents : null;

    if (!Number.isFinite(unitMsrp) && Number.isFinite(unitBase)) unitMsrp = unitBase;
    if (!Number.isFinite(unitBase) && Number.isFinite(unitMsrp)) unitBase = unitMsrp;

    if (!Number.isFinite(unitMsrp) || !Number.isFinite(unitBase)) {
      return { msrpCents: null, priceCents: null, note: "" };
    }

    var subscribePct = 0.25;
    var unitAfter = unitBase * (1 - subscribePct);

    return {
      msrpCents: unitMsrp * qty,
      priceCents: roundCents(unitAfter * qty),
      note: "Includes 25% subscribe & save.",
    };
  }

  function open(ui, opts) {
    opts = opts || {};
    var contractId = safeStr(opts.contractId);
    var line = opts.line || null;

    var catalog = Array.isArray(opts.catalog) ? opts.catalog : [];
    var computePrice = (typeof opts.computePrice === "function") ? opts.computePrice : null;

    var onSubmit = (typeof opts.onSubmit === "function") ? opts.onSubmit : null;

    if (!ui || typeof ui.el !== "function") throw new Error("quantity modal: ui.el is required");
    if (!contractId) return showToast(ui, "Missing contract id.", "error");
    if (!line) return showToast(ui, "Missing line.", "error");

    var initialQty = toInt(line && line.quantity, 1) || 1;

    var state = {
      root: null,
      quantity: initialQty,
      submitting: false,
    };

    var overlay = ui.el("div", { class: "sp-modal", role: "dialog", "aria-modal": "true" }, []);
    var card = ui.el("div", { class: "sp-modal__card" }, []);
    var titleEl = ui.el("div", { class: "sp-modal__title" }, []);
    var bodyEl = ui.el("div", { class: "sp-modal__body" }, []);
    var footerEl = ui.el("div", { class: "sp-modal__footer" }, []);

    function doClose() { closeModal(state); }

    overlay.addEventListener("click", function (e) {
      if (e && e.target === overlay) doClose();
    });

    function rebuildTitle() {
      while (titleEl.firstChild) titleEl.removeChild(titleEl.firstChild);
      titleEl.appendChild(ui.el("div", { class: "sp-addswap-title" }, ["Change quantity"]));
    }

    function rebuildFooter() {
      while (footerEl.firstChild) footerEl.removeChild(footerEl.firstChild);

      var submitBtn = ui.el("button", { type: "button", class: "sp-btn sp-btn-primary" }, ["Submit"]);
      submitBtn.addEventListener("click", function () {
        handleSubmit(doClose, submitBtn);
      });
      footerEl.appendChild(submitBtn);

      var cancelBtn = ui.el("button", { type: "button", class: "sp-btn sp-btn--ghost" }, ["Cancel"]);
      cancelBtn.addEventListener("click", doClose);
      footerEl.appendChild(cancelBtn);
    }

    function rebuildBody() {
      while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);

      bodyEl.appendChild(
        ui.el("div", { class: "sp-note sp-addswap-note" }, [
          ui.el("div", { class: "sp-note__title" }, ["Step 2: Choose quantity"]),
          ui.el("div", { class: "sp-note__body" }, ["Update how many you receive, then submit."]),
        ])
      );

      // Product card (image + title + current flavor)
      var title = safeStr(line && line.title) || "Item";
      var flavor = safeStr(line && line.variantTitle);
      var img = pickImageUrl(line) || pickImageUrl(line && line.variantImage);
      var hasImg = img && isProbablyUrl(img);

      bodyEl.appendChild(
        ui.el("div", { class: "sp-addswap-selected" }, [
          hasImg
            ? ui.el("img", { src: img, alt: title, class: "sp-addswap-selected__img" }, [])
            : ui.el("div", { class: "sp-addswap-selected__img sp-addswap-selected__img--placeholder", "aria-hidden": "true" }, []),

          ui.el("div", { class: "sp-addswap-selected__text" }, [
            ui.el("div", { class: "sp-addswap-selected__title" }, [title]),
            flavor ? ui.el("div", { class: "sp-addswap-selected__headline sp-muted" }, [flavor]) : ui.el("span", {}, []),
          ]),
        ])
      );

      // Quantity select (default = current qty)
      var qty = toInt(state.quantity, initialQty) || initialQty;

      function opt(n) {
        var attrs = { value: String(n) };
        if (qty === n) attrs.selected = "selected";
        return ui.el("option", attrs, [String(n)]);
      }

      var qtyWrap = ui.el("div", { class: "sp-addswap-qty" }, [
        ui.el("div", { class: "sp-addswap-qty__label" }, ["Quantity"]),
        ui.el("select", { class: "sp-select" }, [opt(1), opt(2), opt(3)]),
      ]);

      qtyWrap.querySelector("select").addEventListener("change", function (e) {
        state.quantity = toInt(e && e.target && e.target.value, initialQty) || initialQty;
        rebuildAll(); // re-render price row
      });

      bodyEl.appendChild(qtyWrap);

      // Price row (optional; requires catalog match or computePrice support)
      var vFromCatalog = findVariantFromCatalog(catalog, line && line.variantId);
      if (vFromCatalog || computePrice) {
        var context = { mode: "quantity", contractId: contractId, line: line };
        var out = computeDisplayedPrice(vFromCatalog || { variantId: safeStr(shortId(line && line.variantId)) }, qty, computePrice, context);
        bodyEl.appendChild(renderPriceRow(ui, out.msrpCents, out.priceCents, out.note));
      }
    }

    function rebuildAll() {
      rebuildTitle();
      rebuildBody();
      rebuildFooter();
    }

    async function handleSubmit(closeFn, confirmBtn) {
      if (state.submitting) return;

      var nextQty = toInt(state.quantity, initialQty) || initialQty;

      // ✅ No-op submit: show success and skip any network / action calls
      if (nextQty === initialQty) {
        showToast(ui, "Quantity updated.", "success");
        return closeFn();
      }

      if (!onSubmit) return showToast(ui, "Quantity submit handler is not wired yet.", "error");

      state.submitting = true;
      try {
        confirmBtn.disabled = true;

        await onSubmit({
          contractId: contractId,
          line: line,
          quantity: nextQty,
          prevQuantity: initialQty,
        });

        closeFn();
      } catch (err) {
        showToast(ui, (err && err.message) ? err.message : "Something went wrong.", "error");
        try { confirmBtn.disabled = false; } catch (e2) {}
      } finally {
        state.submitting = false;
      }
    }

    card.appendChild(titleEl);
    card.appendChild(bodyEl);
    card.appendChild(footerEl);
    overlay.appendChild(card);
    state.root = overlay;

    rebuildAll();

    ensureBodyNoScroll(true);
    document.body.appendChild(overlay);
  }

  window.__SP.modals.quantity = { open: open };
})();