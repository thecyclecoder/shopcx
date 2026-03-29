// /actions/toggle-shipping-protection.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.actions = window.__SP.actions || {};
  window.__SP.actions.shippingProtection = window.__SP.actions.shippingProtection || {};

  // -----------------------------------------------------------------------------
  // Shipping Protection toggle (cache-first like pause.js)
  //
  // Flow:
  // 1) Read contract from __sp_subscriptions_cache_v2 (sessionStorage)
  // 2) Build replaceVariants payload using existing ship-prot line detection
  // 3) POST route=replaceVariants
  // 4) Expect resp.patch with { lines, deliveryPrice?, updatedAt? }
  // 5) Patch cached contract + refresh TTL
  // 6) Re-render current screen
  //
  // IMPORTANT FIX:
  // - Preserve original contract.lines shape (Connection w/ .nodes vs array)
  //   so screens/cards that expect contract.lines.nodes don't break after patch.
  // -----------------------------------------------------------------------------

  var SUBS_CACHE_KEY = '__sp_subscriptions_cache_v2';

  function shortId(gid) {
    var s = String(gid || '');
    if (!s) return '';
    var parts = s.split('/');
    return parts[parts.length - 1] || s;
  }

  function toStr(v) {
    return typeof v === 'string' ? v : v == null ? '' : String(v);
  }

  function getAnalytics() {
    return (window.__SP && window.__SP.analytics) || null;
  }

  function trackAction(actionName, extra) {
    try {
      var a = getAnalytics();
      if (!a || typeof a.portalAction !== 'function') return;
      a.portalAction(actionName, extra || {});
    } catch (e) {}
  }

  function trackActionResult(actionName, ok, extra) {
    try {
      var a = getAnalytics();
      if (!a || typeof a.send !== 'function') return;
      a.send(
        'portal_action_result',
        Object.assign(
          { action: String(actionName || ''), status: ok ? 'success' : 'error' },
          extra || {}
        )
      );
    } catch (e) {}
  }

  function hasShippingProtection(contract) {
    var lines = getContractLines(contract);
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (ln && isShipProtLine(ln)) return true;
    }
    return false;
  }

  function toNum(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback == null ? 0 : fallback;
  }

  // ---- cache helpers (mirrors pause.js pattern) ----------------------------

  function looksLikeSubsCacheEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (!entry.ts || typeof entry.ts !== 'number') return false;
    if (!entry.data || typeof entry.data !== 'object') return false;
    if (entry.data.ok !== true) return false;
    if (!Array.isArray(entry.data.contracts)) return false;
    return true;
  }

  function readSubsCacheEntry() {
    try {
      var raw = sessionStorage.getItem(SUBS_CACHE_KEY);
      if (!raw) return null;

      var entry;
      try {
        entry = JSON.parse(raw);
      } catch (e) {
        return null;
      }

      if (!looksLikeSubsCacheEntry(entry)) return null;
      return entry;
    } catch (e) {
      return null;
    }
  }

  function writeSubsCacheEntry(entry) {
    try {
      entry.ts = Date.now();
      sessionStorage.setItem(SUBS_CACHE_KEY, JSON.stringify(entry));
      return true;
    } catch (e) {
      return false;
    }
  }

  function getContractIndexByGid(entry, contractGid) {
    try {
      if (!entry || !entry.data || !Array.isArray(entry.data.contracts)) return -1;
      var cid = String(shortId(contractGid));
      if (!cid) return -1;

      var list = entry.data.contracts;
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || !c.id) continue;
        if (String(shortId(c.id)) === cid) return i;
      }
    } catch (e) {}
    return -1;
  }

  function getContractFromCacheByGid(contractGid) {
    try {
      var entry = readSubsCacheEntry();
      if (!entry) return null;

      var idx = getContractIndexByGid(entry, contractGid);
      if (idx < 0) return null;

      return entry.data.contracts[idx] || null;
    } catch (e) {
      return null;
    }
  }

  // ---- shape-safe patching -------------------------------------------------

  function isLinesConnectionShape(lines) {
    try {
      return !!(lines && typeof lines === 'object' && Array.isArray(lines.nodes));
    } catch (e) {
      return false;
    }
  }

  function applyLinesPatchPreserveShape(baseLines, patchLinesArray) {
    // patchLinesArray should be an array of SubscriptionLine
    var patchArr = Array.isArray(patchLinesArray) ? patchLinesArray : null;
    if (!patchArr) return baseLines;

    // If base is already an array, keep it an array
    if (Array.isArray(baseLines)) return patchArr;

    // If base is a connection with nodes, preserve it and swap nodes
    if (isLinesConnectionShape(baseLines)) {
      var nextConn = {};
      for (var k in baseLines) nextConn[k] = baseLines[k];
      nextConn.nodes = patchArr;

      // Keep __typename stable if missing
      if (!nextConn.__typename) nextConn.__typename = 'SubscriptionLineConnection';
      return nextConn;
    }

    // If base is missing or unknown shape, create a safe connection object
    return {
      __typename: 'SubscriptionLineConnection',
      nodes: patchArr,
      pageInfo:
        baseLines && baseLines.pageInfo
          ? baseLines.pageInfo
          : {
              __typename: 'PageInfo',
              hasPreviousPage: false,
              hasNextPage: false,
              startCursor: null,
              endCursor: null,
            },
    };
  }

  function applyLinesPatchToContract(contract, patch) {
    var base = contract && typeof contract === 'object' ? contract : {};
    var p = patch && typeof patch === 'object' ? patch : {};

    var next = {};
    for (var k in base) next[k] = base[k];

    if (p.lines) {
      next.lines = applyLinesPatchPreserveShape(base.lines, p.lines);
    }

    if (p.deliveryPrice != null) next.deliveryPrice = p.deliveryPrice;
    if (p.updatedAt != null) next.updatedAt = p.updatedAt;

    if (!next.updatedAt) {
      try {
        next.updatedAt = new Date().toISOString();
      } catch (e) {}
    }

    return next;
  }

  function patchContractInCache(contractGid, patch) {
    try {
      var entry = readSubsCacheEntry();
      if (!entry) return { ok: false, error: 'cache_missing' };

      var idx = getContractIndexByGid(entry, contractGid);
      if (idx < 0) return { ok: false, error: 'contract_not_found_in_cache' };

      var existing = entry.data.contracts[idx];
      var base = existing && typeof existing === 'object' ? existing : { id: String(contractGid) };
      var next = applyLinesPatchToContract(base, patch);

      entry.data.contracts[idx] = next;

      var wrote = writeSubsCacheEntry(entry);
      if (!wrote) return { ok: false, error: 'cache_write_failed' };

      return { ok: true, contract: next };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  // ---- contract helpers ----------------------------------------------------

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

  function isShipProtLine(ln) {
    try {
      var t = ln && ln.title ? String(ln.title) : '';
      var tl = t.trim().toLowerCase();
      if (tl === 'shipping protection') return true;
      if (tl.indexOf('shipping protection') >= 0) return true;
    } catch (e) {}

    try {
      if (window.__SP.utils && typeof window.__SP.utils.isShippingProtectionLine === 'function') {
        return !!window.__SP.utils.isShippingProtectionLine(ln);
      }
    } catch (e2) {}

    return false;
  }

  function countNonShipProtLines(contract) {
    var n = 0;
    var lines = getContractLines(contract);
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (!ln) continue;
      if (isShipProtLine(ln)) continue;
      n++;
    }
    return n;
  }

  function findExistingShipProt(contract) {
    var vids = [];
    var lineIds = [];

    var lines = getContractLines(contract);
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (!ln) continue;
      if (!isShipProtLine(ln)) continue;

      try {
        if (ln.id) lineIds.push(String(ln.id));
      } catch (e) {}

      try {
        // ln.variantId may be gid or numeric-like string
        var vid = toNum(shortId(ln.variantId), 0);
        if (vid > 0) vids.push(vid);
      } catch (e2) {}
    }

    // unique
    try {
      vids = Array.from(new Set(vids));
    } catch (_) {}
    try {
      lineIds = Array.from(new Set(lineIds));
    } catch (_) {}

    return { variantIds: vids, lineIds: lineIds };
  }

  // ---- config helpers (optional shop + required variant id for ON) ---------

  function getRoot() {
    return document.querySelector('.subscriptions-portal');
  }

  function pickShipProtVariantIdFromMeta(meta) {
    // primary: meta.shippingProtectionVariantId
    try {
      var id = toNum(meta && meta.shippingProtectionVariantId, 0);
      if (id > 0) return id;
    } catch (e) {}

    // fallback: root attributes (single-variant legacy)
    try {
      var root = getRoot();
      var raw =
        (root && root.getAttribute('data-shipping-protection-variant-id')) ||
        (root && root.getAttribute('data-ship-protection-variant-id')) ||
        (root && root.getAttribute('data-shipping-protection-variant')) ||
        (root && root.getAttribute('data-ship-protection-variant')) ||
        '';
      var n = toNum(String(raw).trim(), 0);
      return n > 0 ? n : 0;
    } catch (e2) {}

    return 0;
  }

  function getCurrentRouteName() {
    try {
      var sp = new URLSearchParams(window.location.search || '');
      var r = String(sp.get('route') || '').trim();
      return r || '';
    } catch (e) {
      return '';
    }
  }

  function syncInMemoryContract(contractGid, nextContract) {
    try {
      if (!window.__SP) return;

      var st = window.__SP.state;
      if (!st || typeof st !== 'object') return;

      var stId =
        st.currentContractId ||
        st.contractId ||
        (st.contract && st.contract.id) ||
        (st.currentContract && st.currentContract.id) ||
        '';

      if (String(shortId(stId)) !== String(shortId(contractGid))) return;

      if (nextContract && typeof nextContract === 'object') {
        if (st.currentContract) st.currentContract = nextContract;
        if (st.contract) st.contract = nextContract;

        if (st.currentContractId) st.currentContractId = contractGid;
        if (st.contractId) st.contractId = contractGid;
      }
    } catch (e) {}
  }

  function refreshCurrentScreen(contractGid) {
    // 1) Emit a generic event (lets screens/cards respond without tight coupling)
    try {
      window.dispatchEvent(
        new CustomEvent('__sp:contract-updated', {
          detail: { contractGid: String(contractGid || ''), ts: Date.now() },
        })
      );
    } catch (e) {}

    // 2) If you have a central renderer, prefer it
    try {
      if (window.__SP && typeof window.__SP.renderCurrentScreen === 'function') {
        window.__SP.renderCurrentScreen();
        return;
      }
    } catch (e0) {}

    // 3) Route-based render (more reliable than “guessing”)
    var route = getCurrentRouteName();

    try {
      if (window.__SP && window.__SP.screens) {
        var screens = window.__SP.screens;

        if (
          (route === 'subscriptionDetail' || route === 'subscription_detail') &&
          screens.subscriptionDetail &&
          typeof screens.subscriptionDetail.render === 'function'
        ) {
          screens.subscriptionDetail.render();
          return;
        }

        if (
          (route === 'subscriptions' || route === 'subscriptions_list') &&
          screens.subscriptions &&
          typeof screens.subscriptions.render === 'function'
        ) {
          screens.subscriptions.render();
          return;
        }
      }
    } catch (e1) {}

    // 4) Fallbacks (original behavior)
    try {
      if (
        window.__SP &&
        window.__SP.screens &&
        window.__SP.screens.subscriptionDetail &&
        typeof window.__SP.screens.subscriptionDetail.render === 'function'
      ) {
        window.__SP.screens.subscriptionDetail.render();
        return;
      }
    } catch (e2) {}

    try {
      if (
        window.__SP &&
        window.__SP.screens &&
        window.__SP.screens.subscriptions &&
        typeof window.__SP.screens.subscriptions.render === 'function'
      ) {
        window.__SP.screens.subscriptions.render();
        return;
      }
    } catch (e3) {}
  }

  var __inFlight = false;

  // Main implementation (internal)
  async function toggleShippingProtectionImpl(ui, contractGid, nextOn, meta) {
    var busy = window.__SP.actions && window.__SP.actions.busy;
    if (!busy) throw new Error('busy_not_loaded');
    if (__inFlight) return { ok: false, error: 'busy' };

    __inFlight = true;

    try {
      return await busy.withBusy(
        ui,
        async function () {
          // IMPORTANT: declare these up-front so catch can safely reference them
          var prevOn = false;
          var desiredOn = false;
          var actionName = 'toggle_shipping_protection_unknown';

          try {
            var contractShortId = toNum(shortId(contractGid), 0);
            if (!contractShortId) throw new Error('missing_contractId');

            // Read contract from cache (like pause.js)
            var contract = getContractFromCacheByGid(contractGid);
            if (!contract) throw new Error('cache_missing_contract');

            prevOn = hasShippingProtection(contract);

            // If caller passes non-boolean or something weird, fall back to toggling
            desiredOn = typeof nextOn === 'boolean' ? nextOn : !prevOn;

            // Directional action name
            actionName = desiredOn
              ? 'toggle_shipping_protection_on'
              : 'toggle_shipping_protection_off';

            // Track attempt
            trackAction(actionName, {
              status: 'attempt',
              prevOn: prevOn ? 1 : 0,
              nextOn: desiredOn ? 1 : 0,
            });

            // Guardrail: can’t add ship prot if there are no regular items
            var nonSpCount = countNonShipProtLines(contract);
            if (desiredOn && nonSpCount < 1) {
              throw new Error('cannot_add_shipping_protection_to_empty_subscription');
            }

            // Variant id required when turning ON
            var shipProtVariantId = pickShipProtVariantIdFromMeta(meta);
            if (desiredOn && !shipProtVariantId) {
              throw new Error('missing_shipping_protection_variant_id');
            }

            var existing = findExistingShipProt(contract);

            var useOldLineId =
              existing.lineIds && existing.lineIds.length === 1 ? existing.lineIds[0] : '';
            var removeVariantIds = existing.variantIds || [];

            var newVariants = undefined;
            if (desiredOn) {
              newVariants = {};
              newVariants[String(shipProtVariantId)] = 1; // qty hard 1
            }

            var payload = {
              contractId: contractShortId,

              oldLineId: useOldLineId || undefined,
              oldVariants: useOldLineId
                ? undefined
                : removeVariantIds.length
                  ? removeVariantIds
                  : undefined,

              newVariants: newVariants,

              eventSource: 'CUSTOMER_PORTAL',
              stopSwapEmails: true,
              carryForwardDiscount: 'PRODUCT_THEN_EXISTING',

              // IMPORTANT: Vercel guardrail requires explicit allow on remove-only operations
              allowRemoveWithoutAdd: !desiredOn ? true : undefined,
            };

            // If turning OFF and there is nothing to remove, treat as success (already off)
            if (!desiredOn) {
              var hasRemoval = !!(
                payload.oldLineId ||
                (payload.oldVariants && payload.oldVariants.length)
              );
              if (!hasRemoval) {
                try {
                  busy.showToast(ui, 'Shipping protection removed.', 'success');
                } catch (e) {}

                // Track noop success too (useful for dashboards)
                trackAction(actionName, {
                  status: 'success',
                  prevOn: prevOn ? 1 : 0,
                  nextOn: 0,
                  afterOn: 0,
                  noop: 1,
                });
                trackActionResult(actionName, true, {
                  prevOn: prevOn ? 1 : 0,
                  nextOn: 0,
                  afterOn: 0,
                  noop: 1,
                });

                return {
                  ok: true,
                  contractId: contractShortId,
                  patch: { lines: getContractLines(contract) },
                  noop: true,
                };
              }
            }

            // POST replaceVariants
            var resp = await window.__SP.api.postJson('replaceVariants', payload);
            if (!resp || resp.ok === false) {
              throw new Error(resp && resp.error ? resp.error : 'replace_variants_failed');
            }

            var patch = resp && resp.patch ? resp.patch : null;
            if (!patch || typeof patch !== 'object') patch = {};

            // Patch cache (now preserves lines shape)
            var result = patchContractInCache(contractGid, patch);
            if (!result.ok) {
              try {
                console.warn('[toggleShippingProtection] cache patch failed:', result.error);
              } catch (e2) {}
            }

            // Some screens render from in-memory state, not sessionStorage
            try {
              syncInMemoryContract(contractGid, result.contract || null);
            } catch (eSync) {}

            // Re-render the active screen so totals/UI recompute
            refreshCurrentScreen(contractGid);

            try {
              busy.showToast(
                ui,
                desiredOn ? 'Shipping protection added.' : 'Shipping protection removed.',
                'success'
              );
            } catch (e3) {}

            var afterOn = false;
            try {
              afterOn = hasShippingProtection(result.contract || null);
            } catch (e4) {}

            trackAction(actionName, {
              status: 'success',
              prevOn: prevOn ? 1 : 0,
              nextOn: desiredOn ? 1 : 0,
              afterOn: afterOn ? 1 : 0,
            });

            trackActionResult(actionName, true, {
              prevOn: prevOn ? 1 : 0,
              nextOn: desiredOn ? 1 : 0,
              afterOn: afterOn ? 1 : 0,
            });

            return { ok: true, contract: result.contract || null, patch: patch };
          } catch (e) {
            try {
              busy.showToast(
                ui,
                'Sorry — we couldn’t update shipping protection. Please try again.',
                'error'
              );
            } catch (_) {}

            trackAction(actionName, {
              status: 'error',
              prevOn: prevOn ? 1 : 0,
              nextOn: desiredOn ? 1 : 0,
            });

            trackActionResult(actionName, false, {
              reason: toStr(e && e.message),
              prevOn: prevOn ? 1 : 0,
              nextOn: desiredOn ? 1 : 0,
            });

            return { ok: false, error: String(e && e.message ? e.message : e) };
          }
        },
        'Updating shipping protection…'
      );
    } finally {
      __inFlight = false;
    }
  }

  // Public API expected by the card:
  window.__SP.actions.shippingProtection.toggle = function (ui, contractGid, nextOn, meta) {
    return toggleShippingProtectionImpl(ui, contractGid, nextOn, meta);
  };
})();
