// /actions/remove.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.actions = window.__SP.actions || {};
  window.__SP.actions.items = window.__SP.actions.items || {};

  // -----------------------------------------------------------------------------
  // Remove line item (cache-first, patch-driven, uses replaceVariants route)
  //
  // Mirrors actions/add-swap.js + toggle-shipping-protection.js patterns:
  // - Read contract from __sp_subscriptions_cache_v2
  // - POST replaceVariants with remove-only payload
  // - Patch cache (preserve lines shape) + sync memory + re-render
  //
  // Signature used by cards/items.js today:
  //   actions.items.remove(ui, contractGid, line)
  // -----------------------------------------------------------------------------

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

  function toNum(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback == null ? 0 : fallback;
  }

  // ---- cache helpers (same as add-swap.js / toggle-shipping-protection.js) ---

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

  // ---- shape-safe patching (same approach as toggle-shipping-protection.js) --

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

    if (p.lines != null) next.lines = applyLinesPatchPreserveShape(base.lines, p.lines);

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

  // ---- contract + “real line” helpers (guardrails) --------------------------

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

  // ---- screen refresh helpers (same as add-swap.js) --------------------------

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

  // ---- main implementation --------------------------------------------------

  async function removeImpl(ui, contractGid, line) {
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
            trackAction('remove', { status: 'attempt' });
            var cGid = toStr(contractGid);
            if (!cGid) throw new Error('missing_contractId');

            var contractShortId = toNum(shortId(cGid), 0);
            if (!contractShortId) throw new Error('missing_contractId_short');

            var ln = line || null;
            if (!ln) throw new Error('missing_line');

            // Read contract from cache (cache-first)
            var contract = getContractFromCacheByGid(cGid);
            if (!contract) throw new Error('cache_missing_contract');

            // Optional guardrail: avoid removing last non-ship-prot line
            // (UI already hides remove when last real line, but keep server-safe)
            try {
              var remaining = countNonShipProtLines(contract);
              if (!isShipProtLine(ln) && remaining <= 1) throw new Error('cannot_remove_last_item');
            } catch (g) {
              if (g && g.message === 'cannot_remove_last_item') throw g; // rethrow guardrail
            }

            // Prefer removing by oldLineId
            var oldLineId = toStr(ln && ln.id);

            // Fallback: remove by variant id numeric
            var oldVariants = null;
            if (!oldLineId) {
              var vid = toNum(shortId(ln && ln.variantId), 0);
              if (vid > 0) oldVariants = [vid];
            }

            if (!oldLineId && !(oldVariants && oldVariants.length)) {
              throw new Error('missing_line_identifiers');
            }

            // Remove-only payload (matches toggle-shipping-protection.js idea)
            var payload = {
              contractId: contractShortId,

              oldLineId: oldLineId || undefined,
              oldVariants: oldLineId ? undefined : oldVariants || undefined,

              // IMPORTANT: remove-only operations must explicitly allow
              allowRemoveWithoutAdd: true,

              eventSource: 'CUSTOMER_PORTAL',
              stopSwapEmails: true,
              carryForwardDiscount: 'PRODUCT_THEN_EXISTING',
            };

            var resp = await window.__SP.api.postJson('replaceVariants', payload);
            if (!resp || resp.ok === false) {
              throw new Error(resp && resp.error ? resp.error : 'replace_variants_failed');
            }

            var patch = resp && resp.patch ? resp.patch : null;
            if (!patch || typeof patch !== 'object') patch = {};

            // Patch cache (preserve lines shape)
            var result = patchContractInCache(cGid, patch);
            if (!result.ok) {
              try {
                console.warn('[remove] cache patch failed:', result.error);
              } catch (e2) {}
            }

            // Sync in-memory + rerender
            try {
              syncInMemoryContract(cGid, result.contract || null);
            } catch (eSync) {}
            refreshCurrentScreen(cGid);

            try {
              busy.showToast(ui, 'Item removed.', 'success');
            } catch (e3) {}
            trackAction('remove', { status: 'success' });
            trackActionResult('remove', true);
            return { ok: true, contract: result.contract || null, patch: patch };
          } catch (e) {
            // Friendly message for guardrail
            var msg = e && e.message ? String(e.message) : 'Something went wrong.';
            if (msg === 'cannot_remove_last_item') {
              try {
                busy.showToast(ui, 'You can’t remove the last item from a subscription.', 'error');
              } catch (_) {}
              return { ok: false, error: msg };
            }

            try {
              busy.showToast(
                ui,
                'Sorry — we couldn’t remove this item. Please try again.',
                'error'
              );
            } catch (_) {}
            trackAction('remove', { status: 'error' });
            trackActionResult('remove', false, {
              reason: toStr(e && e.message),
            });
            return { ok: false, error: msg };
          }
        },
        'Removing item…'
      );
    } finally {
      __inFlight = false;
    }
  }

  // Public API expected by cards/items.js
  window.__SP.actions.items.remove = function (ui, contractGid, line) {
    return removeImpl(ui, contractGid, line);
  };
})();
