// portal-src/modals/add-swap.js
// Shared modal for Add Product + Swap Product (same UI, different submit handler)
//
// Two-step flow:
//   Step 1: Select product
//   Step 2: Select flavor + quantity
//
// Product rows are clickable (no visible radios).
// Stars render as: ★★★★☆ 4.8 (123)
//
// Pricing shown on step 2:
// - MSRP comes from catalog (variant compare_at / msrp if present, else variant price)
// - "Your price" applies:
//    25% subscribe & save discount (always)
//    PLUS tier discount based on resulting quantities across ALL "real" line items:
//      minQty >= 4 => 16%
//      minQty == 3 => 12%
//      minQty == 2 =>  8%
//      otherwise   =>  0%
//
// To compute tier discount we need current line quantities.
// Pass one of these into opts:
//
//  A) opts.getLineSnapshot(): () => [{ variantId, quantity, isReal?: boolean }]
//     (recommended; always current)
//
//  B) opts.lineSnapshot: [{ variantId, quantity, isReal?: boolean }]
//
// For swap mode, the modal will replace the swapped line’s quantity with the selected quantity
// when computing the tier discount. It will also replace variantId if user selects a different variant.

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

    // strip currency + commas
    s = s.replace(/[$,]/g, "").trim();
    // if it's "79.95"
    var n = Number(s);
    if (!Number.isFinite(n)) return null;

    // If it looks like dollars (has decimal or small number), convert.
    // If it looks like cents already (e.g. 7995), keep.
    if (s.indexOf(".") !== -1 || n < 1000) {
      return Math.round(n * 100);
    }
    return Math.trunc(n);
  }

  function roundCents(x) {
    return Math.round(Number(x) || 0);
  }

  // ----------------------------
  // Robust scalar extraction (prevents [object Object])
  // ----------------------------

  function isPlainObject(x) {
    return !!x && typeof x === "object" && !Array.isArray(x);
  }

  function pickScalar(v) {
    if (v == null) return "";
    if (typeof v === "string") return v.trim();
    if (typeof v === "number" || typeof v === "boolean") return String(v);

    if (isPlainObject(v)) {
      // Metafield-ish
      if (v.value != null) return pickScalar(v.value);
      if (v.stringValue != null) return pickScalar(v.stringValue);
      if (v.text != null) return pickScalar(v.text);
      if (v.label != null) return pickScalar(v.label);

      // Image/url-ish
      if (v.url != null) return pickScalar(v.url);
      if (v.src != null) return pickScalar(v.src);
      if (v.transformedSrc != null) return pickScalar(v.transformedSrc);
      if (v.originalSrc != null) return pickScalar(v.originalSrc);

      // Nested
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

  // ----------------------------
  // Normalization helpers
  // ----------------------------

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

  function pickHeadline(p) {
    var v =
      pickScalar(p && p.directResponseHeadline) ||
      pickScalar(p && p.direct_response_headline) ||
      pickScalar(p && p.metafields && (p.metafields.direct_response_headline || p.metafields.directResponseHeadline)) ||
      "";
    return safeStr(v).trim();
  }

  function pickSubhead(p) {
    var v =
      pickScalar(p && p.directResponseSubhead) ||
      pickScalar(p && p.direct_response_subhead) ||
      pickScalar(p && p.metafields && (p.metafields.direct_response_subhead || p.metafields.directResponseSubhead)) ||
      "";
    return safeStr(v).trim();
  }

  function pickRatingValue(p) {
    var v = toNum(p && p.ratingValue, null);
    if (v == null && p && p.rating && p.rating.value != null) v = toNum(p.rating.value, null);

    if (v == null && p && p.metafields) {
      var mf = p.metafields;

      v = toNum(pickScalar(mf.rating_value), null);
      if (v == null) v = toNum(pickScalar(mf.ratingValue), null);
      if (v == null) v = toNum(pickScalar(mf.reviews_rating), null);

      if (v == null && mf.reviews_rating && isPlainObject(mf.reviews_rating)) {
        var rr = mf.reviews_rating.value != null ? mf.reviews_rating.value : mf.reviews_rating;
        if (rr && isPlainObject(rr)) {
          v = toNum(pickScalar(rr.rating), null);
          if (v == null) v = toNum(pickScalar(rr.value), null);
        }
      }
    }

    if (v != null && (v < 0 || v > 5.5)) return null;
    return v;
  }

  function pickRatingCount(p) {
    var v = toNum(p && p.ratingCount, null);
    if (v == null && p && p.rating && p.rating.count != null) v = toNum(p.rating.count, null);

    if (v == null && p && p.metafields) {
      var mf = p.metafields;

      v = toNum(pickScalar(mf.rating_count), null);
      if (v == null) v = toNum(pickScalar(mf.ratingCount), null);
      if (v == null) v = toNum(pickScalar(mf.reviews_count), null);

      if (v == null && mf.reviews_rating && isPlainObject(mf.reviews_rating)) {
        var rr = mf.reviews_rating.value != null ? mf.reviews_rating.value : mf.reviews_rating;
        if (rr && isPlainObject(rr)) {
          v = toNum(pickScalar(rr.count), null);
        }
      }
    }

    if (v != null && v < 0) return null;
    return v;
  }

  function pickVariantPriceCents(rawV) {
    if (!rawV) return null;

    // Prefer explicit cents fields
    var c =
      (typeof rawV.priceCents === "number" ? rawV.priceCents : null) ||
      (typeof rawV.price_cents === "number" ? rawV.price_cents : null) ||
      (typeof rawV.price_cent === "number" ? rawV.price_cent : null);

    if (Number.isFinite(c)) return Math.trunc(c);

    // Fallback: strings like "79.95"
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
      directResponseHeadline: pickHeadline(rawP),
      directResponseSubhead: pickSubhead(rawP),
      ratingValue: pickRatingValue(rawP),
      ratingCount: pickRatingCount(rawP),
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

  function filterVariants(product, excludeSet) {
    var vs = (product && Array.isArray(product.variants)) ? product.variants : [];
    if (!excludeSet || typeof excludeSet.has !== "function") return vs.slice();
    var out = [];
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i];
      if (!v) continue;
      var id = safeStr(v.variantId);
      if (!id) continue;
      if (excludeSet.has(id)) continue;
      out.push(v);
    }
    return out;
  }

  // ----------------------------
  // Modal / UI helpers
  // ----------------------------

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

  function renderStarsInline(ui, ratingValue, ratingCount) {
    if (!Number.isFinite(ratingValue) || ratingValue <= 0) return ui.el("span", {}, []);

    var rv = Math.max(0, Math.min(5, ratingValue));
    var base = Math.floor(rv);
    var dec = rv - base;

    var full = base;
    var half = 0;

    if (dec >= 0.3 && dec <= 0.7) {
      half = 1;
    } else if (dec > 0.7) {
      full = Math.min(5, full + 1);
    }

    var empty = 5 - full - half;
    var HALF = "⯨";
    var stars = "";
    for (var i = 0; i < full; i++) stars += "★";
    if (half) stars += HALF;
    for (var j = 0; j < empty; j++) stars += "☆";

    var suffix = "";
    if (Number.isFinite(ratingCount) && ratingCount > 0) {
      suffix = " (" + String(Math.trunc(ratingCount)) + ")";
    }

    return ui.el("div", { class: "sp-addswap-stars" }, [
      ui.el("span", { class: "sp-addswap-stars__glyphs" }, [stars]),
      ui.el("span", { class: "sp-addswap-stars__text sp-muted" }, [String(rv.toFixed(1)) + suffix]),
    ]);
  }

  function rowBtnAttrs(isSelected) {
    return {
      type: "button",
      class: "sp-addswap-rowbtn sp-btn sp-btn--ghost" + (isSelected ? " is-selected" : ""),
    };
  }

  function productRowBtn(ui, product, onClick) {
    var title = safeStr(product && product.title) || "Product";
    var img = safeStr(product && product.imageUrl);
    var headline = safeStr(product && product.directResponseHeadline);
    var subhead = safeStr(product && product.directResponseSubhead);

    var ratingValue = product && product.ratingValue;
    var ratingCount = product && product.ratingCount;

    var hasImg = img && isProbablyUrl(img);

    var btn = ui.el("button", rowBtnAttrs(false), [
      ui.el("div", { class: "sp-addswap-rowbtn__inner sp-addswap-prodrow" }, [
        ui.el("div", { class: "sp-addswap-prodrow__imgwrap" }, [
          hasImg
            ? ui.el("img", { src: img, alt: title, class: "sp-addswap-prodrow__img" }, [])
            : ui.el("div", { class: "sp-addswap-prodrow__img sp-addswap-prodrow__img--placeholder", "aria-hidden": "true" }, []),

          ui.el("div", { class: "sp-addswap-prodrow__selectcue", "aria-hidden": "true" }, ["Select"]),
        ]),

        ui.el("div", { class: "sp-addswap-prodrow__text" }, [
          ui.el("div", { class: "sp-addswap-prodrow__title" }, [title]),
          headline ? ui.el("div", { class: "sp-addswap-prodrow__headline sp-muted" }, [headline]) : ui.el("span", {}, []),
          subhead ? ui.el("div", { class: "sp-addswap-prodrow__subhead sp-muted" }, [subhead]) : ui.el("span", {}, []),
          renderStarsInline(ui, ratingValue, ratingCount),
        ]),
      ]),
    ]);

    if (typeof onClick === "function") btn.addEventListener("click", onClick);
    return btn;
  }

  function variantRowBtn(ui, variant, isSelected, onClick) {
    var label = safeStr(variant && variant.title) || "Option";
    var img = safeStr(variant && variant.imageUrl);
    var hasImg = img && isProbablyUrl(img);

    var attrs = rowBtnAttrs(!!isSelected);

    var btn = ui.el("button", attrs, [
      ui.el("div", { class: "sp-addswap-rowbtn__inner sp-addswap-varrow" }, [
        hasImg
          ? ui.el("img", { src: img, alt: label, class: "sp-addswap-varrow__img" }, [])
          : ui.el("div", { class: "sp-addswap-varrow__img sp-addswap-varrow__img--placeholder", "aria-hidden": "true" }, []),
        ui.el("div", { class: "sp-addswap-varrow__label" }, [label]),
      ]),
    ]);

    if (typeof onClick === "function") btn.addEventListener("click", onClick);
    return btn;
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

  function tierDiscountFromTotalQty(totalQty) {
    var q = toInt(totalQty, 0);
    if (q >= 4) return 0;
    if (q === 3) return 0;
    if (q === 2) return 0;
    return 0;
  }

  function computeTierFromSnapshot(snapshot, mode, swappedLine, newVariantId, newQty) {
    var arr = Array.isArray(snapshot) ? snapshot : [];
    var real = [];

    for (var i = 0; i < arr.length; i++) {
      var it = arr[i] || {};
      var id = safeStr(it.id);
      var vid = safeStr(it.variantId);
      var qty = toInt(it.quantity, 0);
      var isReal = (it.isReal === false) ? false : true;
      if (!vid || qty <= 0 || !isReal) continue;

      real.push({ id: id, variantId: vid, quantity: qty });
    }

    // SWAP: replace the swapped line with the selected qty + selected variant BEFORE summing
    if (mode === "swap" && swappedLine) {
      var swappedId = safeStr(swappedLine.id);
      var oldVid = safeStr(swappedLine.variantId);
      var replaced = false;

      // Prefer matching by line id (best)
      if (swappedId) {
        for (var r0 = 0; r0 < real.length; r0++) {
          if (real[r0].id && real[r0].id === swappedId) {
            real[r0].variantId = safeStr(newVariantId) || real[r0].variantId;
            real[r0].quantity = toInt(newQty, 0);
            replaced = true;
            break;
          }
        }
      }

      // Fallback: match by old variant id (legacy)
      if (!replaced && oldVid) {
        for (var r = 0; r < real.length; r++) {
          if (real[r].variantId === oldVid) {
            real[r].variantId = safeStr(newVariantId) || real[r].variantId;
            real[r].quantity = toInt(newQty, 0);
            replaced = true;
            break;
          }
        }
      }

      // If not found, include best-effort
      if (!replaced && safeStr(newVariantId)) {
        real.push({ id: "", variantId: safeStr(newVariantId), quantity: toInt(newQty, 0) });
      }
    }

    // ADD: include the new item so tier updates live
    if (mode !== "swap" && safeStr(newVariantId)) {
      real.push({ id: "", variantId: safeStr(newVariantId), quantity: toInt(newQty, 0) });
    }

    if (!real.length) return { totalQty: 0, tierPct: 0 };

    // ✅ SUM across all real lines
    var total = 0;
    for (var j = 0; j < real.length; j++) {
      total += toInt(real[j].quantity, 0);
    }

    return { totalQty: total, tierPct: tierDiscountFromTotalQty(total) };
  }

  // ----------------------------
  // Open
  // ----------------------------

  function open(ui, opts) {
    opts = opts || {};
    var mode = (safeStr(opts.mode).toLowerCase() === "swap") ? "swap" : "add";
    var contractId = safeStr(opts.contractId);
    var line = opts.line || null; // swapped line object (should include variantId ideally)
    var excludeVariantIds = opts.excludeVariantIds || null;
    var catalog = normalizeCatalog(opts.catalog);

    // Optional external price calculator (still supported)
    var computePrice = (typeof opts.computePrice === "function") ? opts.computePrice : null;

    // Snapshot support for tier pricing
    var getLineSnapshot = (typeof opts.getLineSnapshot === "function") ? opts.getLineSnapshot : null;
    var staticSnapshot = Array.isArray(opts.lineSnapshot) ? opts.lineSnapshot : null;

    var onSubmit = (typeof opts.onSubmit === "function") ? opts.onSubmit : null;

    if (!ui || typeof ui.el !== "function") throw new Error("add-swap modal: ui.el is required");
    if (!contractId) return showToast(ui, "Missing contract id.", "error");
    if (mode === "swap" && !line) return showToast(ui, "Missing line for swap.", "error");
    if (!catalog.length) return showToast(ui, "No products available.", "error");

    // state
    var state = {
      root: null,
      step: 1, // 1=product, 2=flavor+qty
      selectedProductKey: "",
      selectedVariantId: "",
      quantity: 2, // default to 2
      submitting: false,
    };

    function productKey(p, idx) {
      return safeStr(p && p.productId) || safeStr(p && p.title) || ("p_" + String(idx || 0));
    }

    function getSelectedProduct() {
      for (var i2 = 0; i2 < catalog.length; i2++) {
        var p2 = catalog[i2];
        if (!p2) continue;
        if (productKey(p2, i2) === state.selectedProductKey) return p2;
      }
      return null;
    }

    function getSelectedVariant(product) {
      if (!product) return null;
      var allowed = filterVariants(product, excludeVariantIds);
      for (var j = 0; j < allowed.length; j++) {
        var v = allowed[j];
        if (safeStr(v && v.variantId) === state.selectedVariantId) return v;
      }
      return allowed.length ? allowed[0] : null;
    }

function getSnapshotNow() {
      try {
        if (getLineSnapshot) {
          var s = getLineSnapshot() || [];
          return s;
        }
      } catch (e) {

      }

      return staticSnapshot || [];
    }

    function computeDisplayedPriceForVariant(variant, qty) {
      qty = toInt(qty, 1) || 1;
      if (!variant) return { msrpCents: null, priceCents: null, note: "" };

      // Allow external calculator override if provided
      if (computePrice) {
        try {
          var out = computePrice({
            variant: variant,
            qty: qty,
            context: { mode: mode, contractId: contractId, line: line }
          }) || {};
          if (Number.isFinite(out.msrpCents) || Number.isFinite(out.priceCents)) {
            return {
              msrpCents: Number.isFinite(out.msrpCents) ? out.msrpCents : null,
              priceCents: Number.isFinite(out.priceCents) ? out.priceCents : null,
              note: safeStr(out.note || ""),
            };
          }
        } catch (e0) {}
      }

      // Default internal pricing
      var unitMsrp = Number.isFinite(variant.msrpCents) ? variant.msrpCents : null;
      var unitBase = Number.isFinite(variant.priceCents) ? variant.priceCents : null;

      // If msrp missing, treat "msrp" as base price so the strike-through still makes sense
      if (!Number.isFinite(unitMsrp) && Number.isFinite(unitBase)) unitMsrp = unitBase;
      if (!Number.isFinite(unitBase) && Number.isFinite(unitMsrp)) unitBase = unitMsrp;

      if (!Number.isFinite(unitMsrp) || !Number.isFinite(unitBase)) {
        return { msrpCents: null, priceCents: null, note: "" };
      }

      // Always 25% subscribe & save off MSRP/base
      var subscribePct = 0.25;

      // Tier discount depends on resulting min quantity across real items
      var snap = getSnapshotNow();
      var tierInfo = computeTierFromSnapshot(snap, mode, line, variant.variantId, qty);
      var tierPct = tierInfo.tierPct;

      var unitAfter = unitBase * (1 - subscribePct) * (1 - tierPct);
      var totalMsrp = unitMsrp * qty;
      var totalAfter = roundCents(unitAfter * qty);

      var note = "";
      if (tierPct > 0) {
        note = "Includes " + Math.round(tierPct * 100) + "% bundle discount at qty " + String(tierInfo.totalQty) + ".";
      } else {
        note = "Includes 25% subscribe & save.";
      }

      return { msrpCents: totalMsrp, priceCents: totalAfter, note: note };
    }

    // Build modal DOM
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

      titleEl.appendChild(
        ui.el("div", { class: "sp-addswap-title" }, [
          state.step === 1
            ? (mode === "swap" ? "Swap product" : "Add product")
            : "Choose flavor",
        ])
      );
    }

    function rebuildFooter() {
      while (footerEl.firstChild) footerEl.removeChild(footerEl.firstChild);

      // Step 2: Submit first, Cancel second
      if (state.step === 2) {
        var submitBtn = ui.el("button", { type: "button", class: "sp-btn sp-btn-primary sp-addswap-submit" }, ["Submit"]);
        submitBtn.addEventListener("click", function () {
          handleSubmit(doClose, submitBtn);
        });
        footerEl.appendChild(submitBtn);

        var cancelBtn2 = ui.el("button", { type: "button", class: "sp-btn sp-btn--ghost" }, ["Cancel"]);
        cancelBtn2.addEventListener("click", doClose);
        footerEl.appendChild(cancelBtn2);
        return;
      }

      // Step 1: only cancel
      var cancelBtn = ui.el("button", { type: "button", class: "sp-btn sp-btn--ghost" }, ["Cancel"]);
      cancelBtn.addEventListener("click", doClose);
      footerEl.appendChild(cancelBtn);
    }

    function rebuildBody() {
      while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);

      bodyEl.appendChild(
        ui.el("div", { class: "sp-note sp-addswap-note" }, [
          ui.el("div", { class: "sp-note__title" }, [
            state.step === 1 ? "Step 1: Choose your new product" : "Step 2: Choose flavor and quantity",
          ]),
          ui.el("div", { class: "sp-note__body" }, [
            state.step === 1
              ? "Tap a product below to continue."
              : "Pick your flavor and quantity, then submit.",
          ]),
        ])
      );

      if (state.step === 1) {
        var list = ui.el("div", { class: "sp-addswap-list sp-addswap-list--products" }, []);

        for (var i = 0; i < catalog.length; i++) {
          (function (prod, idx) {
            if (!prod) return;

            var allowed = filterVariants(prod, excludeVariantIds);
            if (!allowed.length) return;

            var key = productKey(prod, idx);

            list.appendChild(
              productRowBtn(ui, prod, function () {
                state.selectedProductKey = key;

                // When entering step 2, force default qty = 2 every time
                state.quantity = 2;

                state.selectedVariantId = safeStr(allowed[0].variantId);
                state.step = 2;
                rebuildAll();
              })
            );
          })(catalog[i], i);
        }

        bodyEl.appendChild(ui.el("div", { class: "sp-addswap-sectionlabel" }, ["Product"]));
        bodyEl.appendChild(list);
        return;
      }

      // Step 2
      var p = getSelectedProduct();

      var backBtn = ui.el("button", { type: "button", class: "sp-btn sp-btn--ghost sp-addswap-back" }, ["← Back"]);
      backBtn.addEventListener("click", function () {
        state.step = 1;
        rebuildAll();
      });

      bodyEl.appendChild(
        ui.el("div", { class: "sp-addswap-toprow" }, [
          backBtn,
          ui.el("div", { class: "sp-addswap-toprow__hint sp-muted" }, [
            mode === "swap" ? "You’re swapping this item" : "You’re adding a new item",
          ]),
        ])
      );

      if (p) {
        var img = safeStr(p.imageUrl);
        var hasPImg = img && isProbablyUrl(img);

        bodyEl.appendChild(
          ui.el("div", { class: "sp-addswap-selected" }, [
            hasPImg
              ? ui.el("img", { src: img, alt: p.title, class: "sp-addswap-selected__img" }, [])
              : ui.el("div", { class: "sp-addswap-selected__img sp-addswap-selected__img--placeholder", "aria-hidden": "true" }, []),

            ui.el("div", { class: "sp-addswap-selected__text" }, [
              ui.el("div", { class: "sp-addswap-selected__title" }, [p.title]),
              p.directResponseHeadline ? ui.el("div", { class: "sp-addswap-selected__headline sp-muted" }, [p.directResponseHeadline]) : ui.el("span", {}, []),
              renderStarsInline(ui, p.ratingValue, p.ratingCount),
            ]),
          ])
        );
      }

      var allowedVariants = p ? filterVariants(p, excludeVariantIds) : [];
      var v = getSelectedVariant(p);

      bodyEl.appendChild(ui.el("div", { class: "sp-addswap-sectionlabel sp-addswap-sectionlabel--spaced" }, ["Flavor"]));

      var vList = ui.el("div", { class: "sp-addswap-list sp-addswap-list--variants" }, []);
      for (var j2 = 0; j2 < allowedVariants.length; j2++) {
        (function (vv) {
          var id = safeStr(vv && vv.variantId);
          vList.appendChild(
            variantRowBtn(ui, vv, id === state.selectedVariantId, function () {
              state.selectedVariantId = id;
              rebuildAll(); // re-computes price too
            })
          );
        })(allowedVariants[j2]);
      }
      bodyEl.appendChild(vList);

      // Quantity (default 2)
      var qty = toInt(state.quantity, 2) || 2;

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
        state.quantity = toInt(e && e.target && e.target.value, 2) || 2;
        rebuildAll(); // re-computes tier + price
      });

      bodyEl.appendChild(qtyWrap);

      // Price display (always compute from catalog + rules if computePrice not provided)
      var priceOut = computeDisplayedPriceForVariant(v, state.quantity);
      bodyEl.appendChild(renderPriceRow(ui, priceOut.msrpCents, priceOut.priceCents, priceOut.note));
    }

    function rebuildAll() {
      rebuildTitle();
      rebuildBody();
      rebuildFooter();
    }

    async function handleSubmit(closeFn, confirmBtn) {
      if (state.submitting) return;
      if (!onSubmit) return showToast(ui, "Submit handler is not wired yet.", "error");

      var p = getSelectedProduct();
      var v = getSelectedVariant(p);

      if (!p) return showToast(ui, "Please select a product.", "error");
      if (!v || !safeStr(v.variantId)) return showToast(ui, "Please select a flavor.", "error");

      state.submitting = true;
      try {
        confirmBtn.disabled = true;

        await onSubmit({
          mode: mode,
          contractId: contractId,
          line: line,
          variantId: safeStr(v.variantId),
          variant: v,
          product: p,
          quantity: toInt(state.quantity, 2) || 2,
        });

        closeFn();
      } catch (err) {
        showToast(ui, (err && err.message) ? err.message : "Something went wrong.", "error");
        try { confirmBtn.disabled = false; } catch (e2) {}
      } finally {
        state.submitting = false;
      }
    }

    // Initialize
    state.step = 1;
    state.selectedProductKey = "";
    state.selectedVariantId = "";
    state.quantity = 2;

    card.appendChild(titleEl);
    card.appendChild(bodyEl);
    card.appendChild(footerEl);
    overlay.appendChild(card);
    state.root = overlay;

    rebuildAll();

    ensureBodyNoScroll(true);
    document.body.appendChild(overlay);
  }

  window.__SP.modals.addSwap = {
    open: open,
    _normalizeCatalog: normalizeCatalog,
  };
})();