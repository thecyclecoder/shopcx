// assets/portal-cards-items.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.cards = window.__SP.cards || {};

  function sectionTitle(ui, title, sub) {
    return ui.el('div', { class: 'sp-detail__sectionhead' }, [
      ui.el('div', { class: 'sp-title2' }, [title]),
      sub ? ui.el('p', { class: 'sp-muted sp-detail__section-sub' }, [sub]) : ui.el('span', {}, []),
    ]);
  }

  function safeStr(v) {
    return typeof v === 'string' ? v : v == null ? '' : String(v);
  }

  function toNum(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback == null ? 0 : fallback;
  }

  function shortId(gid) {
    var s = String(gid || '');
    if (!s) return '';
    var parts = s.split('/');
    return parts[parts.length - 1] || s;
  }

  function showToast(ui, msg, type) {
    try {
      var busy = window.__SP.actions && window.__SP.actions.busy;
      if (busy && typeof busy.showToast === 'function') {
        busy.showToast(ui, msg, type || 'success');
        return;
      }
    } catch (e) {}
    try {
      console.log('[toast]', type || 'info', msg);
    } catch (e2) {}
  }

  function getLineImageUrl(ln, utils) {
    try {
      if (utils && typeof utils.safeStr === 'function') {
        return utils.safeStr(ln && ln.variantImage && ln.variantImage.transformedSrc);
      }
    } catch (e) {}
    return safeStr(ln && ln.variantImage && ln.variantImage.transformedSrc);
  }

  function getContractLines(contract) {
    try {
      if (contract && Array.isArray(contract.lines)) return contract.lines;
    } catch (e) {}
    try {
      if (contract && contract.lines && Array.isArray(contract.lines.nodes))
        return contract.lines.nodes;
    } catch (e2) {}
    return [];
  }

  function splitLinesExcludingShipProt(contract, utils) {
    var all = getContractLines(contract);
    var shipLine = null;
    var lines = [];

    for (var i = 0; i < all.length; i++) {
      var ln = all[i];
      if (!ln) continue;

      var isShip = false;
      try {
        if (utils && typeof utils.isShippingProtectionLine === 'function') {
          isShip = !!utils.isShippingProtectionLine(ln);
        }
      } catch (e) {
        isShip = false;
      }

      if (isShip && !shipLine) shipLine = ln;
      else lines.push(ln);
    }

    return { shipLine: shipLine, lines: lines };
  }

  // ---- tier pricing snapshot helpers --------------------------------------

  function isRealLineForTier(ln, utils) {
    if (!ln) return false;

    // Exclude shipping protection (and similar non-real items)
    try {
      if (utils && typeof utils.isShippingProtectionLine === 'function') {
        if (utils.isShippingProtectionLine(ln)) return false;
      }
    } catch (e) {}

    // Must have a variant + positive quantity
    var vId = safeStr(ln && ln.variantId);
    if (!vId) return false;

    var qty = toNum(ln && ln.quantity, 0);
    if (!(qty > 0)) return false;

    // Exclude lines that look "non-real" / placeholder-ish
    // (safe no-op if fields don't exist)
    try {
      if (ln.isRemoved || ln.isDeleted) return false;
    } catch (e2) {}

    return true;
  }

  function buildLineSnapshotFromContract(contract, utils) {
    // Returns an array of "real" lines that tier-pricing logic can use.
    // IMPORTANT: uses only the in-memory/cached contract object passed into this card.
    var all = getContractLines(contract);
    var snap = [];

    for (var i = 0; i < all.length; i++) {
      var ln = all[i];
      if (!isRealLineForTier(ln, utils)) continue;

      snap.push({
        id: safeStr(ln && ln.id),
        variantId: safeStr(ln && ln.variantId),
        quantity: toNum(ln && ln.quantity, 1) || 1,
      });
    }

    return snap;
  }

  function addBtn(ui, text, onClick, opts) {
    opts = opts || {};
    var disabled = !!opts.disabled;

    var attrs = {
      type: 'button',
      class: 'sp-btn sp-btn--ghost',
    };
    if (disabled) {
      attrs.class += ' sp-btn--disabled';
      attrs.disabled = true;
    }

    var btn = ui.el('button', attrs, [text]);
    if (!disabled && typeof onClick === 'function') btn.addEventListener('click', onClick);
    return btn;
  }

  // ---------------- catalog + modal wiring ----------------

  function parseJsonAttribute(str) {
    var s = safeStr(str).trim();
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch (e) {
      return null;
    }
  }

  function getCatalogFromDom() {
    // Catalog is attached to root div data-products-available-to-add='[...]'
    // We grab the first occurrence on the page.
    try {
      var el =
        document.querySelector('[data-products-available-to-add]') ||
        document.querySelector('[data-products-available-to-add-json]') ||
        null;
      if (!el) return [];
      var raw =
        el.getAttribute('data-products-available-to-add') ||
        el.getAttribute('data-products-available-to-add-json') ||
        '';
      var parsed = parseJsonAttribute(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e2) {
      return [];
    }
  }

  function buildVariantPriceMapFromCatalog(catalog) {
    // returns:
    //  { msrpCentsByVariantId: { [id:number]: number }, priceCentsByVariantId: { [id:number]: number } }
    var msrpCentsByVariantId = {};
    var priceCentsByVariantId = {};

    if (!Array.isArray(catalog))
      return {
        msrpCentsByVariantId: msrpCentsByVariantId,
        priceCentsByVariantId: priceCentsByVariantId,
      };

    for (var i = 0; i < catalog.length; i++) {
      var p = catalog[i];
      var vars = p && Array.isArray(p.variants) ? p.variants : [];
      for (var j = 0; j < vars.length; j++) {
        var v = vars[j];
        if (!v) continue;

        var id = toNum(v.id, 0);
        if (!id) continue;

        var priceCents = toNum(v.price_cents, 0);
        var compareCents = toNum(v.compare_at_price_cents, 0);

        // MSRP: prefer compare_at if present; otherwise treat price as MSRP baseline
        var msrpCents = compareCents > 0 ? compareCents : priceCents > 0 ? priceCents : 0;

        if (priceCents > 0) priceCentsByVariantId[id] = priceCents;
        if (msrpCents > 0) msrpCentsByVariantId[id] = msrpCents;
      }
    }

    return {
      msrpCentsByVariantId: msrpCentsByVariantId,
      priceCentsByVariantId: priceCentsByVariantId,
    };
  }

  function buildExcludeVariantIdSet(lines) {
    var set = new Set();
    for (var i = 0; i < (lines ? lines.length : 0); i++) {
      var id = safeStr(lines[i] && lines[i].variantId);
      if (id) set.add(id);
    }
    return set;
  }

  function pickAddSwapModal() {
    try {
      var m = window.__SP && window.__SP.modals && window.__SP.modals.addSwap;
      if (m && typeof m.open === 'function') return m;
    } catch (e) {}
    return null;
  }

  function pickRemoveModal() {
    try {
      var m = window.__SP && window.__SP.modals && window.__SP.modals.remove;
      if (m && typeof m.open === 'function') return m;
    } catch (e) {}
    return null;
  }

  function openRemoveModal(ui, args) {
    var modal = pickRemoveModal();
    if (!modal) {
      showToast(ui, 'Remove modal is not loaded.', 'error');
      return;
    }

    var actions = args.actions || null;

    // Catalog (DOM) so modal can show MSRP / price like add-swap step 2
    var catalog = getCatalogFromDom();
    if (!catalog.length) {
      // No catalog found = still allow modal (it will just omit price row)
      catalog = [];
    }

    var computePrice = pickComputePrice(actions);

    modal.open(ui, {
      contractId: args.contractId,
      line: args.line || null,
      catalog: catalog,
      computePrice: computePrice,

      onRemove: async function () {
        // Keep “remove” action wiring consistent with how you already expect it.
        if (!actions || !actions.items || typeof actions.items.remove !== 'function') {
          throw new Error('Remove is not wired yet.');
        }
        return actions.items.remove(ui, String(args.contractId), args.line);
      },

      onSwapInstead: function () {
        if (typeof args.onSwapInstead === 'function') args.onSwapInstead();
      },
    });
  }

  function pickQuantityModal() {
    try {
      var m = window.__SP && window.__SP.modals && window.__SP.modals.quantity;
      if (m && typeof m.open === 'function') return m;
    } catch (e) {}
    return null;
  }

  function openQuantityModal(ui, args) {
    var modal = pickQuantityModal();
    if (!modal) {
      showToast(ui, 'Quantity modal is not loaded.', 'error');
      return;
    }

    var actions = args.actions || null;

    // Catalog (DOM) so modal can show MSRP / price like add-swap step 2
    var catalog = getCatalogFromDom();
    if (!catalog.length) catalog = [];

    var computePrice = pickComputePrice(actions);

    modal.open(ui, {
      contractId: args.contractId,
      line: args.line || null,
      catalog: catalog,
      computePrice: computePrice,

      onSubmit: async function (payload) {
        // For now, we’ll call the existing hook if present.
        // You said you’ll ask next for actions/quantity.js — we’ll wire that in there.
        if (!actions || !actions.items) throw new Error('Actions not available.');
        var items = actions.items;

        // Prefer a dedicated handler if you add it later
        if (typeof items.submitQuantity === 'function') return items.submitQuantity(ui, payload);
        if (typeof items.changeQty === 'function') {
          // Maintain backward compatibility with existing pattern
          return items.changeQty(ui, String(args.contractId), args.line, payload.quantity, payload);
        }

        throw new Error('Quantity action is not wired yet.');
      },
    });
  }

  function pickComputePrice(actions) {
    // Optional: let actions supply pricing (recommended).
    // Signature expected by modal:
    //   computePrice({ variant, qty, context }) => { msrpCents, priceCents }
    try {
      if (actions && actions.items && typeof actions.items.computeAddSwapPrice === 'function') {
        return actions.items.computeAddSwapPrice;
      }
    } catch (e) {}
    try {
      if (actions && actions.pricing && typeof actions.pricing.computeAddSwapPrice === 'function') {
        return actions.pricing.computeAddSwapPrice;
      }
    } catch (e2) {}
    return null;
  }

  async function submitAddSwap(actions, ui, payload) {
    // We try a few possible handlers, in priority order.
    // payload:
    //   { mode, contractId, line, variantId, variant, product, quantity }
    if (!actions || !actions.items) throw new Error('Actions not available.');

    var items = actions.items;

    // Preferred unified handler
    if (typeof items.submitAddSwap === 'function') return items.submitAddSwap(ui, payload);
    if (typeof items.applyAddSwap === 'function') return items.applyAddSwap(ui, payload);
    if (typeof items.addSwapSubmit === 'function') return items.addSwapSubmit(ui, payload);

    // Separate handlers (swap vs add)
    if (payload.mode === 'swap') {
      if (typeof items.submitSwap === 'function') return items.submitSwap(ui, payload);
      if (typeof items.swapSubmit === 'function')
        return items.swapSubmit(
          ui,
          payload.contractId,
          payload.line,
          payload.variantId,
          payload.quantity,
          payload
        );
      if (typeof items.swapToVariant === 'function')
        return items.swapToVariant(
          ui,
          payload.contractId,
          payload.line,
          payload.variantId,
          payload.quantity,
          payload
        );
      if (typeof items.replaceVariant === 'function')
        return items.replaceVariant(
          ui,
          payload.contractId,
          payload.line,
          payload.variantId,
          payload.quantity,
          payload
        );
    } else {
      if (typeof items.submitAdd === 'function') return items.submitAdd(ui, payload);
      if (typeof items.addSubmit === 'function')
        return items.addSubmit(
          ui,
          payload.contractId,
          payload.variantId,
          payload.quantity,
          payload
        );
      if (typeof items.addVariant === 'function')
        return items.addVariant(
          ui,
          payload.contractId,
          payload.variantId,
          payload.quantity,
          payload
        );
      if (typeof items.addLine === 'function')
        return items.addLine(ui, payload.contractId, payload.variantId, payload.quantity, payload);
    }

    throw new Error('Add/Swap submit handler is not wired yet.');
  }

  function openAddSwapModal(ui, args) {
    var modal = pickAddSwapModal();
    if (!modal) {
      showToast(ui, 'Add/Swap modal is not loaded.', 'error');
      return;
    }

    var actions = args.actions || null;
    var catalog = getCatalogFromDom();
    if (!catalog.length) {
      showToast(ui, 'No catalog data found on page.', 'error');
      return;
    }

    var computePrice = pickComputePrice(actions);

    modal.open(ui, {
      mode: args.mode,
      contractId: args.contractId,
      line: args.line || null,
      catalog: catalog, // raw; modal normalizes
      excludeVariantIds: args.excludeVariantIds || null,
      computePrice: computePrice,

      // ✅ Tier pricing snapshot (no fresh fetch; uses cached/in-memory contract/lines)
      // Modal will call this as quantity/variant changes to recalc tier pricing.
      getLineSnapshot: typeof args.getLineSnapshot === 'function' ? args.getLineSnapshot : null,
      lineSnapshot: args.lineSnapshot || null,

      onSubmit: async function (payload) {
        await submitAddSwap(actions, ui, payload);
      },
    });
  }

  // ---------------- money helpers ----------------

  function pickCurrency(contract, lines) {
    try {
      if (contract && contract.deliveryPrice && contract.deliveryPrice.currencyCode) {
        return String(contract.deliveryPrice.currencyCode);
      }
    } catch (e) {}
    try {
      var ln0 = lines && lines[0];
      if (ln0 && ln0.currentPrice && ln0.currentPrice.currencyCode)
        return String(ln0.currentPrice.currencyCode);
    } catch (e2) {}
    try {
      var ln1 = lines && lines[0];
      if (ln1 && ln1.lineDiscountedPrice && ln1.lineDiscountedPrice.currencyCode)
        return String(ln1.lineDiscountedPrice.currencyCode);
    } catch (e3) {}
    return 'USD';
  }

  function moneyAmount(m) {
    try {
      if (!m) return 0;
      return toNum(m.amount, 0);
    } catch (e) {
      return 0;
    }
  }

  function formatMoney(amount, currencyCode) {
    var n = toNum(amount, 0);
    var fixed = (Math.round(n * 100) / 100).toFixed(2);
    if (!currencyCode || String(currencyCode).toUpperCase() === 'USD') return '$' + fixed;
    return String(currencyCode).toUpperCase() + ' ' + fixed;
  }

  function centsToMoney(cents) {
    return toNum(cents, 0) / 100;
  }

  function formatCouponLabel(title) {
    var s = safeStr(title);
    if (!s) return '';

    var max = 8; // show first 8 chars
    if (s.length <= max) return s;

    return s.slice(0, max) + '…';
  }

  function computeLinePrices(ln, msrpCentsByVariantId) {
    var qty = toNum(ln && ln.quantity, 1) || 1;

    // Base "before coupon" (what customer pays absent manual coupon)
    // ✅ Use currentPrice (unit) * qty as the baseline for subscription pricing.
    var currentUnit = moneyAmount(ln && ln.currentPrice);
    var lineCurrent = currentUnit > 0 ? currentUnit * qty : 0;

    // "After coupon" (if present). Appstle/Shopify usually provides this on lineDiscountedPrice.
    var lineDiscounted = moneyAmount(ln && ln.lineDiscountedPrice);
    var lineNow = lineDiscounted > 0 ? lineDiscounted : lineCurrent;

    // MSRP from catalog (preferred)
    var unitMsrp = 0;
    try {
      var vId = toNum(shortId(ln && ln.variantId), 0);
      if (vId && msrpCentsByVariantId && msrpCentsByVariantId[vId] != null) {
        unitMsrp = centsToMoney(msrpCentsByVariantId[vId]);
      }
    } catch (e) {
      unitMsrp = 0;
    }

    // Fallback MSRP: pricingPolicy.basePrice (if needed)
    if (!(unitMsrp > 0)) {
      try {
        unitMsrp = moneyAmount(ln && ln.pricingPolicy && ln.pricingPolicy.basePrice);
      } catch (e2) {
        unitMsrp = 0;
      }
    }

    // If we still don't have MSRP, treat current as MSRP baseline for "Subtotal"
    if (!(unitMsrp > 0)) unitMsrp = currentUnit > 0 ? currentUnit : 0;

    var lineMsrp = unitMsrp > 0 ? unitMsrp * qty : 0;

    // Show strike-through on the line only when MSRP > current (before coupon)
    var showMsrp = false;
    if (lineMsrp > 0 && lineCurrent >= 0 && lineMsrp > lineCurrent + 0.009) showMsrp = true;

    // Coupon discount allocation (if provided)
    var couponAlloc = 0;
    try {
      var allocs = ln && ln.discountAllocations;
      if (Array.isArray(allocs) && allocs.length) {
        for (var i = 0; i < allocs.length; i++) {
          var a = allocs[i];
          var amt = moneyAmount(a && a.amount);
          if (amt > 0) couponAlloc += amt;
        }
      }
    } catch (e3) {
      couponAlloc = 0;
    }

    return {
      qty: qty,

      // MSRP
      unitMsrp: unitMsrp,
      lineMsrp: lineMsrp,

      // Subscription pricing before coupon
      unitCurrent: currentUnit,
      lineCurrent: lineCurrent,

      // After coupon (if present)
      lineNow: lineNow,

      // Coupon dollars on this line (if available)
      couponAlloc: couponAlloc,

      // For line item strike-through
      showMsrp: showMsrp,
    };
  }

  // ---- line row (image + details + price) ------------

  function renderLineRow(ui, ln, utils, currencyCode, msrpCentsByVariantId) {
    var img = getLineImageUrl(ln, utils);
    var title =
      (utils && utils.safeStr ? utils.safeStr(ln && ln.title) : safeStr(ln && ln.title)) || 'Item';
    var variant =
      utils && utils.safeStr
        ? utils.safeStr(ln && ln.variantTitle)
        : safeStr(ln && ln.variantTitle);

    var p = computeLinePrices(ln, msrpCentsByVariantId);
    var qty = p.qty;

    var priceBlock = ui.el('div', { class: 'sp-line__priceblock' }, [
      p.showMsrp
        ? ui.el('div', { class: 'sp-line__msrp' }, [formatMoney(p.lineMsrp, currencyCode)])
        : ui.el('span', {}, []),
      ui.el('div', { class: 'sp-line__price' }, [formatMoney(p.lineCurrent, currencyCode)]),
    ]);

    return ui.el('div', { class: 'sp-line sp-line--detail' }, [
      img
        ? ui.el('img', { class: 'sp-line__img', src: img, alt: title })
        : ui.el('div', { class: 'sp-line__img sp-line__img--placeholder' }, []),

      ui.el('div', { class: 'sp-line__meta' }, [
        ui.el('div', { class: 'sp-line__title' }, [title]),
        variant
          ? ui.el('div', { class: 'sp-line__sub sp-muted' }, [variant])
          : ui.el('span', {}, []),
        ui.el('div', { class: 'sp-line__sub sp-muted' }, [
          'Qty ' + String(isFinite(qty) ? qty : 1),
        ]),
      ]),

      priceBlock,
    ]);
  }

  // ---- action option button (ghost button with title + description) ----------

  function optionBtn(ui, title, desc, onClick, opts) {
    opts = opts || {};
    var disabled = !!opts.disabled;

    var attrs = { type: 'button', class: 'sp-btn sp-btn--ghost sp-itemopt' };
    if (disabled) {
      attrs.class += ' sp-btn--disabled';
      attrs.disabled = true;
    }

    var btn = ui.el('button', attrs, [
      ui.el('div', { class: 'sp-itemopt__title' }, [title]),
      desc ? ui.el('div', { class: 'sp-itemopt__desc sp-muted' }, [desc]) : ui.el('span', {}, []),
    ]);

    if (!disabled && typeof onClick === 'function') btn.addEventListener('click', onClick);
    return btn;
  }

  function createDisclosure(
    ui,
    ln,
    contract,
    utils,
    actions,
    isReadOnly,
    totalRealLines,
    excludeVariantIds
  ) {
    // If the subscription is cancelled (or read-only), hide the entire "Make changes" UI
    var status = '';
    try {
      status = safeStr(contract && contract.status).toUpperCase();
    } catch (e) {
      status = '';
    }

    if (isReadOnly || status === 'CANCELLED') {
      return {
        btn: null,
        disclosureRow: ui.el('span', {}, []),
        panel: ui.el('span', {}, []),
      };
    }
    var canAct = !isReadOnly && !!(contract && contract.id);

    function onSwap() {
      if (!canAct) return;

      openAddSwapModal(ui, {
        mode: 'swap',
        contractId: String(contract.id),
        line: ln,
        excludeVariantIds: excludeVariantIds,
        actions: actions,

        // ✅ Snapshot of REAL lines only (excludes ship protection + non-real)
        // Modal handles swap-mode override (swapped line becomes selected qty/variant)
        getLineSnapshot: function () {
          return buildLineSnapshotFromContract(contract, utils);
        },
      });
    }

    function onQty() {
      if (!canAct) return;

      openQuantityModal(ui, {
        contractId: String(contract.id),
        line: ln,
        actions: actions,
      });
    }

    function onRemove() {
      if (!canAct) return;

      openRemoveModal(ui, {
        contractId: String(contract.id),
        line: ln,
        actions: actions,
        onSwapInstead: function () {
          // Reuse the exact swap flow you already have
          openAddSwapModal(ui, {
            mode: 'swap',
            contractId: String(contract.id),
            line: ln,
            excludeVariantIds: excludeVariantIds,
            actions: actions,

            // ✅ Snapshot of REAL lines only (excludes ship protection + non-real)
            getLineSnapshot: function () {
              return buildLineSnapshotFromContract(contract, utils);
            },
          });
        },
      });
    }

    var btn = ui.el(
      'button',
      { type: 'button', class: 'sp-btn sp-btn--ghost sp-disclosurebtn', 'aria-expanded': 'false' },
      [
        ui.el('span', { class: 'sp-disclosurebtn__label' }, ['Make changes to this item']),
        ui.el('span', { class: 'sp-disclosurebtn__chev', 'aria-hidden': 'true' }, ['▾']),
      ]
    );

    var disclosureRow = ui.el('div', { class: 'sp-line__disclosure' }, [btn]);
    var canRemove = toNum(totalRealLines, 0) > 1;

    var panel = ui.el(
      'div',
      {
        class: 'sp-line__panel',
        style: 'padding:10px 10px; border-radius:12px; background:#fcf4ee;',
      },
      [
        ui.el(
          'div',
          { class: 'sp-detail__actions sp-detail__actions--stack sp-itemopt__stack' },
          (function () {
            var opts = [
              optionBtn(ui, 'Swap', 'Choose different flavor or product.', onSwap, {
                disabled: !canAct,
              }),
              optionBtn(ui, 'Change quantity', 'Update how many you receive.', onQty, {
                disabled: !canAct,
              }),
            ];

            if (canRemove) {
              opts.push(
                optionBtn(ui, 'Remove', 'Remove this item.', onRemove, { disabled: !canAct })
              );
            }

            return opts;
          })()
        ),
      ]
    );
    panel.hidden = true;

    return { btn: btn, disclosureRow: disclosureRow, panel: panel };
  }

  // ---- totals block ---------------------------------------------------------
  function pickContractPercentDiscount(contract) {
    // Returns: { pct: number, title: string } or { pct: 0, title: "" }
    try {
      var disc = contract && contract.discounts;
      var nodes = null;

      if (disc && Array.isArray(disc)) nodes = disc;
      else if (disc && Array.isArray(disc.nodes)) nodes = disc.nodes;

      if (!nodes || !nodes.length) return { pct: 0, title: '' };

      // Prefer first valid percentage discount
      for (var i = 0; i < nodes.length; i++) {
        var d = nodes[i];
        if (!d) continue;

        // You said you only use coupons that apply to all items; still sanity-check a bit:
        // - percentage exists
        // - targetType is LINE_ITEM (your example)
        var pct = toNum(d && d.value && d.value.percentage, 0);
        if (!(pct > 0)) continue;

        var targetType = safeStr(d && d.targetType).toUpperCase();
        if (targetType && targetType !== 'LINE_ITEM') continue;

        return {
          pct: pct,
          title: safeStr(d && d.title),
        };
      }

      return { pct: 0, title: '' };
    } catch (e) {
      return { pct: 0, title: '' };
    }
  }

  function clampPct(p) {
    var n = toNum(p, 0);
    if (!(n > 0)) return 0;
    if (n > 100) return 100;
    return n;
  }
  function computeTotals(contract, lines, shipLine, currencyCode, msrpCentsByVariantId) {
    var subtotalMsrp = 0;

    // Before-coupon subscription price (what you want Items Subtotal to reflect)
    var itemsCurrent = 0;

    // After-coupon price (what you want Total to reflect)
    var itemsNow = 0;

    // Coupon dollars (prefer allocations)
    var couponNow = 0;

    // Shipping protection
    var shipProtMsrp = 0;
    var shipProtCurrent = 0;
    var shipProtNow = 0;
    var shipProtCoupon = 0;

    for (var i = 0; i < lines.length; i++) {
      var p = computeLinePrices(lines[i], msrpCentsByVariantId);
      subtotalMsrp += toNum(p.lineMsrp, 0);
      itemsCurrent += toNum(p.lineCurrent, 0);
      itemsNow += toNum(p.lineNow, 0);
      couponNow += toNum(p.couponAlloc, 0);
    }

    if (shipLine) {
      var sp = computeLinePrices(shipLine, msrpCentsByVariantId);
      shipProtMsrp = toNum(sp.lineMsrp, 0);
      shipProtCurrent = toNum(sp.lineCurrent, 0);
      shipProtNow = toNum(sp.lineNow, 0);
      shipProtCoupon = toNum(sp.couponAlloc, 0);
    }

    // If coupon allocations are missing but contract shows % coupon, fall back to pct math
    // (This ensures coupons still show even if allocations are omitted in some responses.)
    var disc = pickContractPercentDiscount(contract);
    var pct = clampPct(disc.pct);
    if (!(couponNow > 0) && pct > 0 && itemsCurrent > 0) {
      couponNow = itemsCurrent * (pct / 100);
    }

    // Shipping (delivery price)
    var ship = 0;
    try {
      ship = moneyAmount(contract && contract.deliveryPrice);
    } catch (e) {
      ship = 0;
    }

    // Discounts row = MSRP - current (before coupon). This is your subscribe & save / pricing-policy delta.
    var discountsNow = 0;
    if (subtotalMsrp > 0 && itemsCurrent > 0) {
      discountsNow = Math.max(0, subtotalMsrp - itemsCurrent);
    }

    // Total = after-coupon items + shipping + shipping protection
    var totalNow = Math.max(0, itemsNow) + ship + Math.max(0, shipProtNow);

    // You save = (MSRP + assumed shipping MSRP) - totalNow
    var realLineCount = 0;
    for (var r = 0; r < lines.length; r++) {
      var q = toNum(lines[r] && lines[r].quantity, 0);
      if (q > 0) realLineCount++;
    }
    // assumed shipping MSRP: $5 if 1 item, $10 if >1 item
    var assumedShipMsrp = realLineCount <= 1 ? 5 : 10;

    var shouldHavePaid = subtotalMsrp + assumedShipMsrp;
    var youSave = Math.max(0, shouldHavePaid - totalNow);

    return {
      // labels/data you’ll render
      subtotalMsrp: subtotalMsrp,
      itemsCurrent: itemsCurrent,
      discountsNow: discountsNow,
      couponTitle: safeStr(disc.title),
      couponPct: pct,
      couponNow: couponNow,

      ship: ship,
      shipDisplayFree: !(ship > 0),

      shipProtNow: shipProtNow,
      shipProtPresent: shipProtNow > 0.009,

      totalNow: totalNow,

      assumedShipMsrp: assumedShipMsrp,
      youSave: youSave,
    };
  }

  function renderTotals(ui, totals, currencyCode) {
    function row(label, right, opts) {
      opts = opts || {};
      var cls = 'sp-items-total__row' + (opts.isTotal ? ' sp-items-total__row--total' : '');
      return ui.el('div', { class: cls }, [
        ui.el('div', { class: 'sp-items-total__label' }, [label]),
        ui.el('div', { class: 'sp-items-total__vals' }, [
          ui.el('span', { class: 'sp-items-total__now' + (opts.muted ? ' sp-muted' : '') }, [
            right,
          ]),
        ]),
      ]);
    }

    function money(n) {
      return formatMoney(toNum(n, 0), currencyCode);
    }
    function negMoney(n) {
      var x = toNum(n, 0);
      if (!(x > 0)) return money(0);
      return '-' + money(x);
    }

    var couponLabel = 'Coupons';
    if (totals.couponTitle) {
      couponLabel = 'Coupon (' + formatCouponLabel(totals.couponTitle) + ')';
    } else if (totals.couponPct > 0)
      couponLabel = 'Coupon (' + String(Math.round(totals.couponPct)) + '%)';

    return ui.el('div', { class: 'sp-items-total' }, [
      // Subtotal = MSRP
      row('Subtotal', money(totals.subtotalMsrp)),

      // Discounts = MSRP - current (before coupon)
      totals.discountsNow > 0.009
        ? row('Discounts', negMoney(totals.discountsNow))
        : ui.el('span', {}, []),

      // Coupons = additional discount from manual code
      totals.couponNow > 0.009
        ? row(couponLabel, negMoney(totals.couponNow))
        : ui.el('span', {}, []),

      // Shipping
      row(
        'Shipping',
        totals.shipDisplayFree
          ? ui.el('span', { class: 'sp-items-total__free' }, ['FREE'])
          : money(totals.ship)
      ),

      // Shipping protection
      totals.shipProtPresent
        ? row('Shipping Protection', money(totals.shipProtNow))
        : ui.el('span', {}, []),

      // Total
      row('Total', money(totals.totalNow), { isTotal: true }),

      // You save
      totals.youSave > 0.009
        ? ui.el('div', { class: 'sp-items-total__row sp-items-total__row--save' }, [
            ui.el('div', { class: 'sp-items-total__label' }, ['You save']),
            ui.el('div', { class: 'sp-items-total__vals' }, [
              ui.el('span', { class: 'sp-items-total__now' }, [money(totals.youSave)]),
            ]),
          ])
        : ui.el('span', {}, []),
    ]);
  }

  // ---- card -----------------------------------------------------------------

  window.__SP.cards.items = {
    render: function render(ui, contractOrCtx, utilsMaybe, optsMaybe) {
      var contract = null;
      var utils = null;
      var actions = null;
      var isReadOnly = false;

      if (contractOrCtx && typeof contractOrCtx === 'object' && contractOrCtx.contract) {
        contract = contractOrCtx.contract || null;
        utils = contractOrCtx.utils || null;
        actions = contractOrCtx.actions || window.__SP.actions || null;
        isReadOnly = !!contractOrCtx.isReadOnly;
      } else {
        contract = contractOrCtx || null;
        utils = utilsMaybe || null;
        actions = window.__SP && window.__SP.actions ? window.__SP.actions : null;
        optsMaybe = optsMaybe || {};
        isReadOnly = !!optsMaybe.isReadOnly;
      }

      var split = splitLinesExcludingShipProt(contract, utils);
      var lines = split.lines;
      var shipLine = split.shipLine;

      // Build MSRP map from catalog (DOM)
      var catalog = getCatalogFromDom();
      var priceMaps = buildVariantPriceMapFromCatalog(catalog);
      var msrpCentsByVariantId = priceMaps.msrpCentsByVariantId;

      var currencyCode = pickCurrency(contract, lines);

      // Exclude set: exclude ALL existing subscription flavors (for both add + swap)
      var excludeVariantIds = buildExcludeVariantIdSet(lines);

      // accordion open state
      var openKey = null;
      if (lines && lines.length === 1) {
        try {
          openKey = lines[0] && lines[0].id ? String(lines[0].id) : null;
        } catch (e) {
          openKey = null;
        }
      }

      var itemParts = [];
      var listChildren = [];

      if (!lines.length) {
        listChildren.push(
          ui.el('p', { class: 'sp-muted' }, ['No items found on this subscription.'])
        );
      } else {
        for (var i = 0; i < lines.length; i++) {
          (function (ln, idx) {
            var key = null;
            try {
              key = ln && ln.id ? String(ln.id) : null;
            } catch (e) {
              key = null;
            }
            if (!key) key = 'line_' + String(idx);

            var rowEl = renderLineRow(ui, ln, utils, currencyCode, msrpCentsByVariantId);
            var d = createDisclosure(
              ui,
              ln,
              contract,
              utils,
              actions,
              isReadOnly,
              lines.length,
              excludeVariantIds
            );

            var group = ui.el('div', { class: 'sp-itemgroup' }, [
              rowEl,
              ui.el('div', { class: 'sp-itemgroup__below' }, [d.disclosureRow, d.panel]),
            ]);

            var wrap = ui.el(
              'div',
              { class: 'sp-line-wrap sp-line-wrap--item', 'data-line-id': key },
              [group]
            );

            itemParts.push({ key: key, wrapEl: wrap, btn: d.btn, panel: d.panel });
            listChildren.push(wrap);
          })(lines[i], i);
        }
      }

      function setOpen(nextKey) {
        openKey = nextKey || null;

        for (var j = 0; j < itemParts.length; j++) {
          var it = itemParts[j];
          var isOpen = !!(openKey && it.key === openKey);

          try {
            if (it.panel) it.panel.hidden = !isOpen;
          } catch (e1) {}
          try {
            if (it.btn) it.btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
          } catch (e2) {}

          try {
            if (it.wrapEl) {
              if (isOpen) it.wrapEl.classList.add('sp-line-wrap--open');
              else it.wrapEl.classList.remove('sp-line-wrap--open');
            }
          } catch (e3) {}
        }
      }

      for (var k = 0; k < itemParts.length; k++) {
        (function (it) {
          if (!it || !it.btn) return;
          it.btn.addEventListener('click', function () {
            var next = openKey && openKey === it.key ? null : it.key;
            setOpen(next);
          });
        })(itemParts[k]);
      }

      setOpen(openKey);

      var linesEl = ui.el('div', { class: 'sp-detail__lines' }, listChildren);

      // Totals (items + ship prot + shipping)
      var totalsEl = ui.el('span', {}, []);
      try {
        if (lines && (lines.length || shipLine)) {
          var totals = computeTotals(contract, lines, shipLine, currencyCode, msrpCentsByVariantId);
          totalsEl = renderTotals(ui, totals, currencyCode);
        }
      } catch (eTotals) {}

      var canAdd = !isReadOnly && !!(contract && contract.id);
      function onAdd() {
        if (!canAdd) return;

        openAddSwapModal(ui, {
          mode: 'add',
          contractId: String(contract.id),
          line: null,
          excludeVariantIds: excludeVariantIds,
          actions: actions,

          // ✅ Snapshot of REAL lines only (excludes ship protection + non-real)
          getLineSnapshot: function () {
            return buildLineSnapshotFromContract(contract, utils);
          },
        });
      }

      // Treat CANCELLED as hard read-only (no actions)
      var statusUpper = '';
      try {
        statusUpper = safeStr(contract && contract.status).toUpperCase();
      } catch (e) {}
      var isCancelled = statusUpper === 'CANCELLED';

      // Only show Add + hint when actions are relevant
      var addRow = null;
      var hint = null;

      if (!isCancelled) {
        addRow = ui.el(
          'div',
          { class: 'sp-detail__actions sp-detail__actions--stack add-product-row' },
          [addBtn(ui, 'Add product', onAdd, { disabled: !canAdd })]
        );

        hint = ui.el('p', { class: 'sp-muted sp-detail__hint' }, [
          isReadOnly ? 'Actions will unlock when available.' : 'Add a product and save even more.',
        ]);
      }

      var cardChildren = [
        sectionTitle(ui, 'Items', 'What’s included in your subscription.'),
        linesEl,
      ];

      // Only append these if they exist
      if (addRow) cardChildren.push(addRow);
      if (hint) cardChildren.push(hint);

      cardChildren.push(totalsEl);

      var card = ui.el('div', { class: 'sp-card sp-detail__card' }, cardChildren);

      return { el: card, lines: lines, shipLine: shipLine };
    },
  };
})();
