// /actions/quantity.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.actions = window.__SP.actions || {};
  window.__SP.actions.items = window.__SP.actions.items || {};

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

  // ---- cache helpers --------------------------------------------------------

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

  // ---- shape-safe patching (preserve .lines vs .lines.nodes) ----------------

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

  // ---- render helpers -------------------------------------------------------

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

  // -----------------------------------------------------------------------------
  // Public handler expected by your modal wiring:
  //   actions.items.submitQuantity(ui, payload)
  // payload:
  //   { contractId, line, quantity, prevQuantity }
  // -----------------------------------------------------------------------------

  async function submitQuantityImpl(ui, payload) {
    var busy = window.__SP.actions && window.__SP.actions.busy;
    if (!busy) throw new Error('Actions not available.');
    if (!window.__SP.api || typeof window.__SP.api.postJson !== 'function')
      throw new Error('API not available.');
    if (__inFlight) return { ok: false, error: 'busy' };

    __inFlight = true;

    try {
      return await busy.withBusy(
        ui,
        async function () {
          try {
            trackAction('quantity', { status: 'attempt' });
            payload = payload || {};
            var contractGid = toStr(payload.contractId);
            var line = payload.line || null;

            if (!contractGid) throw new Error('Missing contract id.');
            if (!line) throw new Error('Missing line.');

            var newQty = Math.trunc(toNum(payload.quantity, 0));
            if (!(newQty > 0)) throw new Error('Invalid quantity.');

            var prevQty = Math.trunc(toNum(payload.prevQuantity, toNum(line && line.quantity, 0)));

            // ✅ No-op guard (extra safety)
            if (prevQty === newQty) {
              try {
                busy.showToast(ui, 'Quantity updated.', 'success');
              } catch (eNoop) {}
              return { ok: true, noop: true };
            }

            var contractShortId = toNum(shortId(contractGid), 0);
            if (!contractShortId) throw new Error('Invalid contract id.');

            // Cache-first read (no fetch)
            var contract = getContractFromCacheByGid(contractGid);
            if (!contract) throw new Error('Contract not found in cache.');

            var oldLineId = toStr(line && line.id);
            if (!oldLineId) throw new Error('Missing line id.');

            var variantNumericId = toNum(shortId(line && line.variantId), 0);
            if (!variantNumericId) throw new Error('Missing variant id.');

            var newVariants = {};
            newVariants[String(variantNumericId)] = newQty;

            var req = {
              contractId: contractShortId,
              oldLineId: oldLineId,
              newVariants: newVariants,

              eventSource: 'CUSTOMER_PORTAL',
              stopSwapEmails: true,
              carryForwardDiscount: 'PRODUCT_THEN_EXISTING',
            };

            var resp = await window.__SP.api.postJson('replaceVariants', req);
            if (!resp || resp.ok === false) {
              throw new Error(resp && resp.error ? resp.error : 'Quantity update failed.');
            }

            var patch = resp && resp.patch && typeof resp.patch === 'object' ? resp.patch : {};

            // Patch cache + sync + rerender
            var result = patchContractInCache(contractGid, patch);
            if (!result.ok) {
              try {
                console.warn('[quantity] cache patch failed:', result.error);
              } catch (e2) {}
            }

            try {
              syncInMemoryContract(contractGid, result.contract || null);
            } catch (eSync) {}
            refreshCurrentScreen(contractGid);

            try {
              busy.showToast(ui, 'Quantity updated.', 'success');
            } catch (e3) {}
            trackAction('quantity', { status: 'success' });
            trackActionResult('quantity', true);
            return { ok: true, contract: result.contract || null, patch: patch };
          } catch (e) {
            try {
              busy.showToast(
                ui,
                'Sorry — we couldn’t update the quantity. Please try again.',
                'error'
              );
            } catch (_) {}
            trackAction('quantity', { status: 'error' });
            trackActionResult('quantity', false, {
              reason: toStr(e && e.message),
            });
            return { ok: false, error: String(e && e.message ? e.message : e) };
          }
        },
        'Updating quantity…'
      );
    } finally {
      __inFlight = false;
    }
  }

  window.__SP.actions.items.submitQuantity = function (ui, payload) {
    return submitQuantityImpl(ui, payload);
  };
})();
