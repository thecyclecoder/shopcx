// /actions/frequency.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.actions = window.__SP.actions || {};
  window.__SP.actions.frequency = window.__SP.actions.frequency || {};

  // -----------------------------------------------------------------------------
  // Frequency (billing interval) update — cache-first, patch-driven
  //
  // Flow:
  // 1) Read contract from __sp_subscriptions_cache_v2 (sessionStorage)
  // 2) Compute current interval from cached contract (billingPolicy preferred, else deliveryPolicy)
  // 3) If selected interval matches current, NO network call -> success toast
  // 4) POST route=frequency to Vercel
  // 5) Expect resp { ok:true, patch:{...} } OR ok:false for expected user errors
  // 6) Patch cached contract in place + refresh TTL (ts = Date.now())
  // 7) Re-render current screen
  // -----------------------------------------------------------------------------

  var SUBS_CACHE_KEY = '__sp_subscriptions_cache_v2';

  function shortId(gid) {
    var s = String(gid || '');
    if (!s) return '';
    var parts = s.split('/');
    return parts[parts.length - 1] || s;
  }

  function s(v) {
    return typeof v === 'string' ? v.trim() : '';
  }

  function toNum(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback == null ? 0 : fallback;
  }

  function normInterval(v) {
    var x = s(v).toUpperCase();
    if (!x || x === '$UNKNOWN') return '';
    return x;
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

  // ---- cache helpers (mirrors pause.js / ship-prot pattern) ------------------

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

  function applyFrequencyPatch(contract, patch) {
    var base = contract && typeof contract === 'object' ? contract : {};
    var p = patch && typeof patch === 'object' ? patch : {};

    // shallow clone
    var next = {};
    for (var k in base) next[k] = base[k];

    // Prefer patch-provided policy objects
    if (p.billingPolicy != null) next.billingPolicy = p.billingPolicy;
    if (p.deliveryPolicy != null) next.deliveryPolicy = p.deliveryPolicy;

    // Other common fields that might change
    if (p.updatedAt != null) next.updatedAt = p.updatedAt;
    if (p.nextBillingDate != null) next.nextBillingDate = p.nextBillingDate;
    if (p.deliveryPrice != null) next.deliveryPrice = p.deliveryPrice;

    // touch updatedAt if missing
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
      var next = applyFrequencyPatch(existing, patch);

      entry.data.contracts[idx] = next;

      var wrote = writeSubsCacheEntry(entry);
      if (!wrote) return { ok: false, error: 'cache_write_failed' };

      return { ok: true, contract: next };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  // ---- contract helpers -----------------------------------------------------

  function pickIntervalFromContract(contract) {
    // ✅ Billing update: prefer billingPolicy, fallback deliveryPolicy
    try {
      var bp = contract && contract.billingPolicy;
      if (bp && typeof bp === 'object') {
        var bc = toNum(bp.intervalCount, 0);
        var bi = normInterval(bp.interval);
        if (bc > 0 && bi) return { intervalCount: bc, interval: bi, source: 'billingPolicy' };
      }
    } catch (e) {}

    try {
      var dp = contract && contract.deliveryPolicy;
      if (dp && typeof dp === 'object') {
        var dc = toNum(dp.intervalCount, 0);
        var di = normInterval(dp.interval);
        if (dc > 0 && di) return { intervalCount: dc, interval: di, source: 'deliveryPolicy' };
      }
    } catch (e2) {}

    return { intervalCount: 0, interval: '', source: '' };
  }

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

  function showToast(ui, msg, type) {
    try {
      var busy = window.__SP.actions && window.__SP.actions.busy;
      if (busy && typeof busy.showToast === 'function') {
        busy.showToast(ui, msg, type || 'success');
      }
    } catch (e) {}
  }

  function messageForError(code) {
    code = String(code || '');
    if (code === 'frequency_not_allowed')
      return 'That frequency isn’t available for this subscription.';
    if (code === 'frequency_no_change') return 'No changes needed.';
    if (code === 'contract_not_found')
      return 'We couldn’t find that subscription. Please refresh and try again.';
    return 'Sorry — we couldn’t update your billing frequency. Please try again.';
  }

  function pickOptionalShop() {
    // Shop param is optional — only pass if we can find it without blocking.
    try {
      if (window.__SP && window.__SP.shop) return String(window.__SP.shop);
    } catch (e) {}

    try {
      var root = document.querySelector('.subscriptions-portal');
      var v =
        (root &&
          (root.getAttribute('data-shop') ||
            root.getAttribute('data-shop-domain') ||
            root.getAttribute('data-shopify-shop-domain'))) ||
        '';
      v = s(v);
      return v || '';
    } catch (e2) {}

    try {
      var qs = new URLSearchParams(String(location && location.search ? location.search : ''));
      var q = s(qs.get('shop'));
      return q || '';
    } catch (e3) {}

    return '';
  }

  function normalizeNextInput(next) {
    // Back-compat:
    // - preferred: { interval, intervalCount }
    // - legacy:    { deliveryInterval, deliveryIntervalCount }
    var interval = normInterval(
      next && (next.interval != null ? next.interval : next.deliveryInterval)
    );
    var intervalCount = toNum(
      next && (next.intervalCount != null ? next.intervalCount : next.deliveryIntervalCount),
      0
    );
    return { interval: interval, intervalCount: intervalCount };
  }

  var __inFlight = false;

  async function updateFrequencyImpl(ui, contractGid, next) {
    var busy = window.__SP.actions && window.__SP.actions.busy;
    if (!busy) throw new Error('busy_not_loaded');
    if (__inFlight) return { ok: false, error: 'busy' };

    __inFlight = true;

    try {
      return await busy.withBusy(
        ui,
        async function () {
          try {
            trackAction('frequency', { status: 'attempt' });
            var contractShortId = toNum(shortId(contractGid), 0);
            if (!contractShortId) throw new Error('missing_contractId');

            // Read contract from cache (source of truth)
            var contract = getContractFromCacheByGid(contractGid);
            if (!contract) throw new Error('cache_missing_contract');

            var desired = normalizeNextInput(next);
            if (!desired.interval || !desired.intervalCount) throw new Error('missing_frequency');

            // No-op check (Appstle dislikes submitting same interval)
            var cur = pickIntervalFromContract(contract);
            if (cur.interval && cur.intervalCount) {
              if (
                cur.interval === desired.interval &&
                cur.intervalCount === desired.intervalCount
              ) {
                showToast(ui, 'Billing frequency updated.', 'success');
                refreshCurrentScreen();
                return { ok: true, noop: true };
              }
            }

            // ✅ New payload for billing interval endpoint:
            var payload = {
              contractId: contractShortId,
              intervalCount: desired.intervalCount,
              interval: desired.interval,
            };

            var shop = pickOptionalShop();
            if (shop) payload.shop = shop;

            // POST to Vercel route: "frequency"
            var resp = await window.__SP.api.postJson('frequency', payload);

            // Vercel route should return HTTP 200 with ok:false for expected user errors
            if (!resp || resp.ok === false) {
              var code = resp && resp.error ? String(resp.error) : 'frequency_update_failed';
              showToast(ui, messageForError(code), 'error');
              return {
                ok: false,
                error: code,
                upstreamStatus: resp && resp.upstreamStatus,
                details: resp && resp.details,
              };
            }

            var patch = resp && resp.patch && typeof resp.patch === 'object' ? resp.patch : {};

            // Patch cache + refresh TTL
            var result = patchContractInCache(contractGid, patch);
            if (!result.ok) {
              try {
                console.warn('[frequency] cache patch failed:', result.error);
              } catch (e2) {}
            }

            refreshCurrentScreen();
            showToast(ui, 'Billing frequency updated.', 'success');

            trackAction('frequency', { status: 'success' });
            trackActionResult('frequency', true);

            return { ok: true, contract: result.contract || null, patch: patch };
          } catch (e) {
            showToast(
              ui,
              'Sorry — we couldn’t update your billing frequency. Please try again.',
              'error'
            );
            trackAction('frequency', { status: 'error' });
            trackActionResult('frequency', false, {
              reason: toStr(e && e.message),
            });
            return { ok: false, error: String(e && e.message ? e.message : e) };
          }
        },
        'Updating frequency…'
      );
    } finally {
      __inFlight = false;
    }
  }

  // Public API expected by the card:
  // window.__SP.actions.frequency.update(ui, contractGid, { intervalCount, interval })
  // (also supports legacy { deliveryIntervalCount, deliveryInterval })
  window.__SP.actions.frequency.update = function (ui, contractGid, next) {
    return updateFrequencyImpl(ui, contractGid, next);
  };
})();
