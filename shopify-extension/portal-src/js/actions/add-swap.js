// /actions/add-swap.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.actions = window.__SP.actions || {};
  window.__SP.actions.items = window.__SP.actions.items || {};

  // -----------------------------------------------------------------------------
  // Add + Swap (cache-first, patch-driven, same replaceVariants Vercel route)
  //
  // Flow:
  // 1) Read contract from __sp_subscriptions_cache_v2 (sessionStorage)
  // 2) Build replaceVariants payload:
  //    - swap: oldLineId = line.id, newVariants = { [variantId]: qty }
  //    - add : newVariants = { [variantId]: qty }
  // 3) POST route=replaceVariants
  // 4) Expect resp.patch with { lines, deliveryPrice?, updatedAt? }
  // 5) Patch cached contract + refresh TTL
  // 6) Sync in-memory state + re-render
  // -----------------------------------------------------------------------------

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

  var SUBS_CACHE_KEY = '__sp_subscriptions_cache_v2';
  var __inFlight = false;

  function shortId(gid) {
    var s = String(gid || '');
    if (!s) return '';
    var parts = s.split('/');
    return parts[parts.length - 1] || s;
  }

  function toStr(v) {
    return typeof v === 'string' ? v : v == null ? '' : String(v);
  }

  function toNum(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback == null ? 0 : fallback;
  }

  function toInt(v, fallback) {
    var n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : fallback == null ? 0 : fallback;
  }

  // ---- cache helpers (mirrors toggle-shipping-protection.js pattern) --------

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

  // ---- shape-safe patching (same as toggle-shipping-protection.js) ----------

  function isLinesConnectionShape(lines) {
    try {
      return !!(lines && typeof lines === 'object' && Array.isArray(lines.nodes));
    } catch (e) {
      return false;
    }
  }

  function applyLinesPatchPreserveShape(baseLines, patchLinesArray) {
    var patchArr = Array.isArray(patchLinesArray) ? patchLinesArray : null;
    if (!patchArr) return baseLines;

    if (Array.isArray(baseLines)) return patchArr;

    if (isLinesConnectionShape(baseLines)) {
      var nextConn = {};
      for (var k in baseLines) nextConn[k] = baseLines[k];
      nextConn.nodes = patchArr;
      if (!nextConn.__typename) nextConn.__typename = 'SubscriptionLineConnection';
      return nextConn;
    }

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

    if (p.deliveryPrice) next.deliveryPrice = p.deliveryPrice;
    if (p.updatedAt) next.updatedAt = p.updatedAt;

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

  // ---- screen refresh helpers ----------------------------------------------

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
    try {
      window.dispatchEvent(
        new CustomEvent('__sp:contract-updated', {
          detail: { contractGid: String(contractGid || ''), ts: Date.now() },
        })
      );
    } catch (e) {}

    try {
      if (window.__SP && typeof window.__SP.renderCurrentScreen === 'function') {
        window.__SP.renderCurrentScreen();
        return;
      }
    } catch (e0) {}

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

  // ---- main submitter -------------------------------------------------------

  async function submitAddSwapImpl(ui, payload) {
    var mode0 = toStr(payload && payload.mode).toLowerCase() === 'swap' ? 'swap' : 'add';
    var actionName = mode0 === 'swap' ? 'swap_item' : 'add_item';

    var busy = window.__SP.actions && window.__SP.actions.busy;
    if (!busy) throw new Error('busy_not_loaded');
    if (!window.__SP.api || typeof window.__SP.api.postJson !== 'function')
      throw new Error('api_not_loaded');
    if (__inFlight) return { ok: false, error: 'busy' };

    __inFlight = true;

    try {
      return await busy.withBusy(
        ui,
        async function () {
          try {
            trackAction(actionName, { status: 'attempt' });
            var mode = toStr(payload && payload.mode).toLowerCase() === 'swap' ? 'swap' : 'add';
            var contractGid = toStr(payload && payload.contractId);
            if (!contractGid) throw new Error('missing_contractId');

            var contractShortId = toNum(shortId(contractGid), 0);
            if (!contractShortId) throw new Error('missing_contractId_short');

            var variantIdRaw = toStr(payload && payload.variantId);
            var variantShortId = toNum(shortId(variantIdRaw), 0);
            if (!variantShortId) throw new Error('missing_variantId');

            var qty = toInt(payload && payload.quantity, 0);
            if (!(qty > 0)) throw new Error('missing_quantity');

            // Read contract from cache (cache-first)
            var contract = getContractFromCacheByGid(contractGid);
            if (!contract) throw new Error('cache_missing_contract');

            // Build replaceVariants payload
            var newVariants = {};
            newVariants[String(variantShortId)] = qty;

            var req = {
              contractId: contractShortId,
              newVariants: newVariants,

              eventSource: 'CUSTOMER_PORTAL',
              stopSwapEmails: true,
              carryForwardDiscount: 'PRODUCT_THEN_EXISTING',
            };

            if (mode === 'swap') {
              var line = payload && payload.line ? payload.line : null;
              if (!line) throw new Error('missing_line_for_swap');

              var oldLineId = toStr(line && line.id);
              if (!oldLineId) throw new Error('missing_oldLineId');

              req.oldLineId = oldLineId;
            }

            // POST replaceVariants
            var resp = await window.__SP.api.postJson('replaceVariants', req);
            if (!resp || resp.ok === false) {
              throw new Error(resp && resp.error ? resp.error : 'replace_variants_failed');
            }

            var patch = resp && resp.patch ? resp.patch : null;
            if (!patch || typeof patch !== 'object') patch = {};

            // Patch cache (preserve lines shape)
            var result = patchContractInCache(contractGid, patch);
            if (!result.ok) {
              try {
                console.warn('[addSwap] cache patch failed:', result.error);
              } catch (e2) {}
            }

            // Sync in-memory + rerender
            try {
              syncInMemoryContract(contractGid, result.contract || null);
            } catch (eSync) {}
            refreshCurrentScreen(contractGid);

            try {
              busy.showToast(ui, mode === 'swap' ? 'Item swapped.' : 'Item added.', 'success');
            } catch (e3) {}
            trackAction(actionName, { status: 'success' });
            trackActionResult(actionName, true);
            return { ok: true, contract: result.contract || null, patch: patch };
          } catch (e) {
            try {
              busy.showToast(
                ui,
                'Sorry — we couldn’t update this subscription. Please try again.',
                'error'
              );
            } catch (_) {}
            trackAction(actionName, { status: 'error' });
            trackActionResult(actionName, false, { reason: toStr(e && e.message) });
            return { ok: false, error: String(e && e.message ? e.message : e) };
          }
        },
        toStr(payload && payload.mode).toLowerCase() === 'swap' ? 'Swapping item…' : 'Adding item…'
      );
    } finally {
      __inFlight = false;
    }
  }

  // Public API (cards/items.js submitAddSwap will find this first)
  window.__SP.actions.items.submitAddSwap = function (ui, payload) {
    return submitAddSwapImpl(ui, payload);
  };

  // Optional convenience aliases (if other code expects them)
  window.__SP.actions.items.applyAddSwap = window.__SP.actions.items.submitAddSwap;
  window.__SP.actions.items.submitSwap = function (ui, payload) {
    payload = payload || {};
    payload.mode = 'swap';
    return submitAddSwapImpl(ui, payload);
  };
  window.__SP.actions.items.submitAdd = function (ui, payload) {
    payload = payload || {};
    payload.mode = 'add';
    return submitAddSwapImpl(ui, payload);
  };
})();
