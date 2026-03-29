(function () {
  window.__SP = window.__SP || {};
  window.__SP.actions = window.__SP.actions || {};

  var SUBS_CACHE_KEY = '__sp_subscriptions_cache_v2';
  var TTL_MS = 10 * 60 * 1000; // 10 minutes

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

  // ---- cache helpers ------------------------------------------------------

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

      // TTL check (for safety; we still allow patching even if expired)
      // If you want to *block* reads when expired, do it in the screen render.
      return entry;
    } catch (e) {
      return null;
    }
  }

  function writeSubsCacheEntry(entry) {
    try {
      // ✅ Refresh TTL to 10 mins by bumping ts to now
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

  // ✅ deterministic: read entry, patch contract at index, write entry back
  function patchContractInCache(contractGid, patch) {
    try {
      var entry = readSubsCacheEntry();
      if (!entry) return { ok: false, error: 'cache_missing' };

      var idx = getContractIndexByGid(entry, contractGid);
      if (idx < 0) return { ok: false, error: 'contract_not_found_in_cache' };

      var existing = entry.data.contracts[idx];
      var base = existing && typeof existing === 'object' ? existing : { id: String(contractGid) };

      var next = applyPatchToContract(base, patch);

      // ✅ replace in place
      entry.data.contracts[idx] = next;

      // ✅ refresh TTL by writing
      var wrote = writeSubsCacheEntry(entry);
      if (!wrote) return { ok: false, error: 'cache_write_failed' };

      return { ok: true, contract: next };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  // ---- patch helpers ------------------------------------------------------

  function normalizeAttrList(list) {
    return Array.isArray(list) ? list : [];
  }

  function mergeCustomAttributes(existingList, patchList) {
    // Merge by key; patchList overwrites existing keys; preserve other keys.
    var out = [];
    var seen = {};

    var existing = normalizeAttrList(existingList);
    for (var i = 0; i < existing.length; i++) {
      var a = existing[i];
      var k = toStr(a && a.key);
      if (!k) continue;
      if (seen[k]) continue;
      seen[k] = true;
      out.push({ key: k, value: toStr(a && a.value) });
    }

    var patch = normalizeAttrList(patchList);
    for (var j = 0; j < patch.length; j++) {
      var p = patch[j];
      var pk = toStr(p && p.key);
      if (!pk) continue;

      var replaced = false;
      for (var t = 0; t < out.length; t++) {
        if (out[t].key === pk) {
          out[t] = { key: pk, value: toStr(p && p.value) };
          replaced = true;
          break;
        }
      }
      if (!replaced) out.push({ key: pk, value: toStr(p && p.value) });
    }

    return out;
  }

  function attrsToMap(customAttributes) {
    var out = {};
    var arr = Array.isArray(customAttributes) ? customAttributes : [];
    for (var i = 0; i < arr.length; i++) {
      var a = arr[i];
      var k = toStr(a && a.key);
      if (!k) continue;
      out[k] = toStr(a && a.value);
    }
    return out;
  }

  function isSoftPausedByPortal(attrsMap) {
    var lastAction = toStr(attrsMap.portal_last_action).toLowerCase();
    var pauseDays = Number(attrsMap.portal_pause_days || '0') || 0;
    if (pauseDays <= 0) return false;
    if (lastAction.indexOf('pause') !== 0) return false;
    return true;
  }

  function buildPortalStateFromContract(contract) {
    var attrsMap = attrsToMap(contract && contract.customAttributes);
    var softPaused = isSoftPausedByPortal(attrsMap);

    return {
      bucket: softPaused ? 'paused' : 'active',
      isSoftPaused: softPaused,

      lastAction: toStr(attrsMap.portal_last_action),
      pauseDays: toStr(attrsMap.portal_pause_days),
      pausedUntil: toStr(attrsMap.portal_paused_until),
      lastActionAt: toStr(attrsMap.portal_last_action_at),

      needsAttention: false,
      attentionReason: '',
      attentionMessage: '',
    };
  }

  function applyPatchToContract(contract, patch) {
    var base = contract && typeof contract === 'object' ? contract : {};
    var p = patch && typeof patch === 'object' ? patch : {};

    // Clone shallow (avoid mutating the cached object by reference)
    var next = {};
    for (var k in base) next[k] = base[k];

    // 1) next billing date
    if (p.nextBillingDate) {
      next.nextBillingDate = toStr(p.nextBillingDate);
    }

    // 2) custom attributes
    if (Array.isArray(p.customAttributes) && p.customAttributes.length) {
      next.customAttributes = mergeCustomAttributes(next.customAttributes, p.customAttributes);
    }

    // 3) recompute portalState
    next.portalState = buildPortalStateFromContract(next);

    // 4) touch updatedAt
    try {
      next.updatedAt = new Date().toISOString();
    } catch (e) {}

    return next;
  }

  // ---- ui helpers ---------------------------------------------------------

  function refreshCurrentScreen() {
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
    } catch (e) {}

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
    } catch (e2) {}
  }

  // ---- action -------------------------------------------------------------

  window.__SP.actions.pause = async function pause(ui, contractGid, days) {
    var busy = window.__SP.actions && window.__SP.actions.busy;
    if (!busy) throw new Error('busy_not_loaded');

    return await busy.withBusy(ui, async function () {
      try {
        trackAction('pause', { status: 'attempt' });
        var contractShortId = Number(shortId(contractGid));

        var resp = await window.__SP.api.postJson('pause', {
          contractId: contractShortId,
          pauseDays: Number(days),
        });

        if (!resp || resp.ok === false) {
          throw new Error(resp && resp.error ? resp.error : 'pause_failed');
        }

        // Expect: resp.patch = { nextBillingDate, customAttributes:[...] }
        var patch = resp.patch || null;
        if (!patch || typeof patch !== 'object') {
          throw new Error('pause_missing_patch');
        }

        // ✅ deterministic cache update: read -> patch -> write (refresh TTL) -> render
        var result = patchContractInCache(contractGid, patch);
        if (!result.ok) {
          // if cache is missing, we still re-render (screen will fetch direct if needed)
          try {
            console.warn('[pause] cache patch failed:', result.error);
          } catch (e) {}
        }

        refreshCurrentScreen();

        busy.showToast(
          ui,
          'Done. Your next order was pushed out ' + String(days) + ' days.',
          'success'
        );
        trackAction('pause', { status: 'success' });
        trackActionResult('pause', true);

        return { ok: true, contract: result.contract || null };
      } catch (e) {
        busy.showToast(
          ui,
          'Sorry — we couldn’t update your subscription. Please try again.',
          'error'
        );
        trackAction('pause', { status: 'error' });
        trackActionResult('pause', false, {
          reason: toStr(e && e.message),
        });
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    });
  };
})();
