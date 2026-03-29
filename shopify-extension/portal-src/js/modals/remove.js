// portal-src/modals/remove.js
// Confirm removal modal (step-2 look-alike of add-swap)
//
// UI:
//  - Shows selected item (image + title + current flavor)
//  - Shows current price row (optional; uses catalog + computePrice if provided)
//  - Footer buttons: Remove / Swap instead / Cancel
//
// opts:
//  { contractId, line, catalog, computePrice?, onRemove?, onSwapInstead? }

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

  function formatMoneyFromCents(cents) {
    var n = toInt(cents, 0);
    var sign = n < 0 ? "-" : "";
    n = Math.abs(n);
    var dollars = Math.floor(n / 100);
    var rem = n % 100;
    var rem2 = rem < 10 ? "0" + String(rem) : String(rem);
    return sign + "$" + String(dollars) + "." + rem2;
  }

  function roundCents(x) {
    return Math.round(Number(x) || 0);
  }

  // ---- catalog normalization (minimal subset of add-swap) --------------------

  function getVariantId(v) {
    var id = (v && (v.variantId != null ? v.variantId : v.id));
    return pickScalar(id) || safeStr(id);
  }

  function getProductId(p) {
    var id = (p && (p.productId != null ? p.productId : p.id));
    return pickScalar(id) || safeStr(id);
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

  function normalizeProduct(rawP) {
    if (!rawP) return null;

    var variants = [];
    var rawVs = (rawP && Array.isArray(rawP.variants)) ? rawP.variants : [];
    for (var i = 0; i < rawVs.length; i++) {
      var nv = normalizeVariant(rawVs[i]);
      if (nv) variants.push(nv);
    }

    var title = safeStr(pickScalar(rawP.title) || rawP.title).trim();
    return {
      productId: getProductId(rawP) || title,
      title: title,
      imageUrl: pickImageUrl(rawP),
      variants: variants,
      _raw: rawP,
    };
  }

  function normalizeCatalog(catalog) {
    var arr = Array.isArray(catalog) ? catalog.filter(Boolean) : [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var p = normalizeProduct(arr[i]);
      if (p && p.productId && p.title) out.push(p);
    }
    return out;
  }

  function findVariantInCatalogById(catalog, variantGid) {
    var vid = safeStr(variantGid);
    if (!vid) return null;
    for (var i = 0; i < catalog.length; i++) {
      var p = catalog[i];
      var vs = (p && Array.isArray(p.variants)) ? p.variants : [];
      for (var j = 0; j < vs.length; j++) {
        var v = vs[j];
        if (v && safeStr(v.variantId) === vid) return { product: p, variant: v };
      }
    }
    return null;
  }

  // ---- UI pieces (reuse add-swap classes) -----------------------------------

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
    if (!variant) return { msrpCents: null, priceCents: null, note: "" };

    // If actions provided a price calculator, prefer it (keeps visuals consistent with add-swap)
    if (typeof computePrice === "function") {
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

    // Simple fallback: show MSRP only (or base) and omit “your price”
    var unitMsrp = Number.isFinite(variant.msrpCents) ? variant.msrpCents : null;
    var unitBase = Number.isFinite(variant.priceCents) ? variant.priceCents : null;
    if (!Number.isFinite(unitMsrp) && Number.isFinite(unitBase)) unitMsrp = unitBase;
    if (!Number.isFinite(unitBase) && Number.isFinite(unitMsrp)) unitBase = unitMsrp;

    if (!Number.isFinite(unitMsrp)) return { msrpCents: null, priceCents: null, note: "" };
    return { msrpCents: unitMsrp * qty, priceCents: null, note: "" };
  }

  // ---- open ----------------------------------------------------------------

  function open(ui, opts) {
    opts = opts || {};
    var contractId = safeStr(opts.contractId);
    var line = opts.line || null;
    var computePrice = (typeof opts.computePrice === "function") ? opts.computePrice : null;
    var catalog = normalizeCatalog(opts.catalog || []);
    var onRemove = (typeof opts.onRemove === "function") ? opts.onRemove : null;
    var onSwapInstead = (typeof opts.onSwapInstead === "function") ? opts.onSwapInstead : null;

    if (!ui || typeof ui.el !== "function") throw new Error("remove modal: ui.el is required");
    if (!contractId) return showToast(ui, "Missing contract id.", "error");
    if (!line) return showToast(ui, "Missing line.", "error");

    var state = { root: null, submitting: false };

    var overlay = ui.el("div", { class: "sp-modal", role: "dialog", "aria-modal": "true" }, []);
    var card = ui.el("div", { class: "sp-modal__card" }, []);
    var titleEl = ui.el("div", { class: "sp-modal__title" }, []);
    var bodyEl = ui.el("div", { class: "sp-modal__body" }, []);
    var footerEl = ui.el("div", { class: "sp-modal__footer" }, []);

    function doClose() { closeModal(state); }

    overlay.addEventListener("click", function (e) {
      if (e && e.target === overlay) doClose();
    });

    // Title
    titleEl.appendChild(
      ui.el("div", { class: "sp-addswap-title" }, ["Remove item"])
    );

    // Body
    bodyEl.appendChild(
      ui.el("div", { class: "sp-note sp-addswap-note" }, [
        ui.el("div", { class: "sp-note__title" }, ["Step 2: Confirm removal"]),
        ui.el("div", { class: "sp-note__body" }, ["You’re about to remove this item from your subscription."]),
      ])
    );

    // Selected “card” (use line data)
    var img = safeStr(line && line.variantImage && line.variantImage.transformedSrc);
    var hasImg = img && isProbablyUrl(img);
    var title = safeStr(line && line.title) || "Item";
    var flavor = safeStr(line && line.variantTitle);

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

    // Price row (optional, but keeps parity with add-swap step 2)
    var found = findVariantInCatalogById(catalog, safeStr(line && line.variantId));
    if (found && found.variant) {
      var qty = toInt(line && line.quantity, 1) || 1;
      var priceOut = computeDisplayedPrice(
        found.variant,
        qty,
        computePrice,
        { mode: "remove", contractId: contractId, line: line }
      );
      bodyEl.appendChild(renderPriceRow(ui, priceOut.msrpCents, priceOut.priceCents, priceOut.note));
    }

    // Footer (Remove / Swap Instead / Cancel)
    var removeBtn = ui.el("button", { type: "button", class: "sp-btn sp-btn-primary sp-addswap-submit" }, ["Remove"]);
    removeBtn.addEventListener("click", async function () {
      if (state.submitting) return;
      if (!onRemove) return showToast(ui, "Remove handler is not wired yet.", "error");

      state.submitting = true;
      try {
        removeBtn.disabled = true;
        await onRemove({ contractId: contractId, line: line });
        doClose();
      } catch (err) {
        showToast(ui, (err && err.message) ? err.message : "Something went wrong.", "error");
        try { removeBtn.disabled = false; } catch (e2) {}
      } finally {
        state.submitting = false;
      }
    });

    var swapBtn = ui.el("button", { type: "button", class: "sp-btn sp-btn--ghost" }, ["Swap instead"]);
    swapBtn.addEventListener("click", function () {
      try {
        doClose();
        if (onSwapInstead) onSwapInstead();
      } catch (e) {}
    });

    var cancelBtn = ui.el("button", { type: "button", class: "sp-btn sp-btn--ghost sp-remove-cancel" }, ["Cancel"]);
    cancelBtn.addEventListener("click", doClose);

    footerEl.appendChild(removeBtn);
    footerEl.appendChild(swapBtn);
    footerEl.appendChild(cancelBtn);

    card.appendChild(titleEl);
    card.appendChild(bodyEl);
    card.appendChild(footerEl);
    overlay.appendChild(card);
    state.root = overlay;

    ensureBodyNoScroll(true);
    document.body.appendChild(overlay);
  }

  window.__SP.modals.remove = { open: open };
})();