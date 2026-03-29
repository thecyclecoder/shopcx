(function () {
  window.__SP = window.__SP || {};
  window.__SP.actions = window.__SP.actions || {};

  // ✅ fixed, known cache key
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
      var entry = JSON.parse(raw);
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

  function getContractFromCacheByGid(contractGid) {
    try {
      var cid = String(shortId(contractGid));
      if (!cid) return null;

      var entry = readSubsCacheEntry();
      if (!entry) return null;

      var list = entry.data.contracts;
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || !c.id) continue;
        if (String(shortId(c.id)) === cid) return c;
      }
    } catch (e) {}
    return null;
  }

  function upsertContractIntoCache(contract) {
    try {
      if (!contract || !contract.id) return false;
      var cid = String(shortId(contract.id));
      if (!cid) return false;

      var entry = readSubsCacheEntry();
      if (!entry) return false;

      var list = entry.data.contracts;

      var replaced = false;
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || !c.id) continue;
        if (String(shortId(c.id)) === cid) {
          list[i] = contract;
          replaced = true;
          break;
        }
      }

      if (!replaced) list.push(contract);

      return writeSubsCacheEntry(entry);
    } catch (e) {
      return false;
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

    // Shallow clone to avoid mutating cached object
    var next = {};
    for (var k in base) next[k] = base[k];

    if (p.nextBillingDate != null) {
      next.nextBillingDate = toStr(p.nextBillingDate);
    }

    if (Array.isArray(p.customAttributes) && p.customAttributes.length) {
      next.customAttributes = mergeCustomAttributes(next.customAttributes, p.customAttributes);
    }

    // IMPORTANT: Recompute portalState from the updated contract
    next.portalState = buildPortalStateFromContract(next);

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

  // inside window.__SP.actions.resume = async function resume...

  window.__SP.actions.resume = async function resume(ui, contractGid, resumeInDays) {
    var busy = window.__SP.actions && window.__SP.actions.busy;
    if (!busy) throw new Error('busy_not_loaded');
    if (!window.__SP.api || typeof window.__SP.api.postJson !== 'function') {
      throw new Error('api_not_loaded');
    }

    return await busy.withBusy(ui, async function () {
      try {
        trackAction('resume', { status: 'attempt' });

        var contractShortId = Number(shortId(contractGid));
        if (!contractShortId) throw new Error('missing_contractId');

        var resp = await window.__SP.api.postJson('resume', {
          contractId: contractShortId,
          resumeInDays: Number(resumeInDays || 1),
        });

        if (!resp || resp.ok === false) {
          throw new Error(resp && resp.error ? resp.error : 'resume_failed');
        }

        var patch = resp.patch || null;
        if (!patch || typeof patch !== 'object') {
          throw new Error('resume_missing_patch');
        }

        var cached = getContractFromCacheByGid(contractGid);
        var base = cached || { id: String(contractGid) };

        var patched = applyPatchToContract(base, patch);

        var wrote = upsertContractIntoCache(patched);
        if (!wrote) {
          try {
            console.warn('[resume] failed to write cache', SUBS_CACHE_KEY);
          } catch (e) {}
        }

        refreshCurrentScreen();

        trackAction('resume', { status: 'success' });
        trackActionResult('resume', true);

        busy.showToast(ui, 'Done. Your subscription will resume tomorrow.', 'success');
        return { ok: true, contract: patched };
      } catch (e) {
        busy.showToast(
          ui,
          'Sorry — we couldn’t resume your subscription. Please try again.',
          'error'
        );

        trackAction('resume', { status: 'error' });
        trackActionResult('resume', false, { reason: toStr(e && e.message) });

        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    });
  };
})();
