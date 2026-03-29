(function () {
  window.__SP = window.__SP || {};
  window.__SP.actions = window.__SP.actions || {};
  window.__SP.actions.coupon = window.__SP.actions.coupon || {};

  var SUBS_CACHE_KEY = '__sp_subscriptions_cache_v2';

  // 2-minute "failed code" memory to prevent spam submits
  var FAILED_CODES_KEY = '__sp_coupon_failed_codes_v1';
  var FAILED_TTL_MS = 2 * 60 * 1000;

  function shortId(gid) {
    var s = String(gid || '');
    if (!s) return '';
    var parts = s.split('/');
    return parts[parts.length - 1] || s;
  }
  function toStr(v) {
    return typeof v === 'string' ? v : v == null ? '' : String(v);
  }

  function s(v) {
    return typeof v === 'string' ? v.trim() : '';
  }

  function toNum(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback == null ? 0 : fallback;
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

  // ---- failed code memory --------------------------------------------------

  function readFailedCodes() {
    try {
      var raw = sessionStorage.getItem(FAILED_CODES_KEY);
      if (!raw) return { ts: Date.now(), items: {} };

      var obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return { ts: Date.now(), items: {} };
      if (!obj.items || typeof obj.items !== 'object') obj.items = {};
      if (!obj.ts || typeof obj.ts !== 'number') obj.ts = Date.now();

      // purge expired
      var now = Date.now();
      var items = obj.items;
      for (var code in items) {
        var exp = Number(items[code]);
        if (!isFinite(exp) || exp <= now) {
          try {
            delete items[code];
          } catch (_) {}
        }
      }

      return obj;
    } catch (e) {
      return { ts: Date.now(), items: {} };
    }
  }

  function writeFailedCodes(obj) {
    try {
      obj.ts = Date.now();
      sessionStorage.setItem(FAILED_CODES_KEY, JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  }

  function isRecentlyFailed(code) {
    code = s(code);
    if (!code) return false;
    var obj = readFailedCodes();
    var exp = obj.items && obj.items[code];
    return typeof exp === 'number' && exp > Date.now();
  }

  function markFailed(code) {
    code = s(code);
    if (!code) return;
    var obj = readFailedCodes();
    obj.items[code] = Date.now() + FAILED_TTL_MS;
    writeFailedCodes(obj);
  }

  function clearFailed(code) {
    code = s(code);
    if (!code) return;
    var obj = readFailedCodes();
    if (obj.items && Object.prototype.hasOwnProperty.call(obj.items, code)) {
      try {
        delete obj.items[code];
      } catch (_) {}
      writeFailedCodes(obj);
    }
  }

  // ---- cache helpers (mirrors your patterns) ------------------------------

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

  function getDiscountNodes(contract) {
    try {
      var d = contract && contract.discounts;
      if (!d) return [];
      if (Array.isArray(d)) return d;
      if (d && Array.isArray(d.nodes)) return d.nodes;
      if (d && Array.isArray(d.edges)) {
        var out = [];
        for (var i = 0; i < d.edges.length; i++) {
          var n = d.edges[i] && d.edges[i].node;
          if (n) out.push(n);
        }
        return out;
      }
    } catch (e) {}
    return [];
  }

  function applyCouponPatchToContract(contract, patch) {
    var base = contract && typeof contract === 'object' ? contract : {};
    var p = patch && typeof patch === 'object' ? patch : {};

    var next = {};
    for (var k in base) next[k] = base[k];

    if (p.discounts != null) next.discounts = p.discounts;
    if (p.deliveryPrice != null) next.deliveryPrice = p.deliveryPrice;
    if (p.updatedAt != null) next.updatedAt = p.updatedAt;
    if (p.nextBillingDate != null) next.nextBillingDate = p.nextBillingDate;

    if (!next.updatedAt) {
      try {
        next.updatedAt = new Date().toISOString();
      } catch (_) {}
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
      var next = applyCouponPatchToContract(base, patch);

      entry.data.contracts[idx] = next;

      var wrote = writeSubsCacheEntry(entry);
      if (!wrote) return { ok: false, error: 'cache_write_failed' };

      return { ok: true, contract: next };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
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

  function pickOptionalShop() {
    try {
      if (window.__SP && window.__SP.shop) return String(window.__SP.shop);
    } catch (e) {}

    try {
      var root = document.querySelector('.subscriptions-portal');
      var v =
        root && (root.getAttribute('data-shop') || root.getAttribute('data-shop-domain') || '');
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

  function toastForCouponError(code) {
    // More final-sounding messages, less “please try again”
    if (code === 'coupon_invalid_or_expired' || code === 'coupon_not_found') {
      return 'Invalid or expired coupon code. Please double-check and try a different code.';
    }
    if (code === 'coupon_conflict' || code === 'coupon_already_applied') {
      return 'This subscription already has a coupon applied.';
    }
    if (code === 'coupon_apply_failed') {
      return 'That coupon can’t be applied to this subscription.';
    }
    if (code === 'coupon_remove_failed' || code === 'discount_not_removable') {
      return 'We couldn’t remove that discount from this subscription.';
    }
    return 'We couldn’t apply that coupon to this subscription.';
  }

  async function postCoupon(ui, payload, mode, discountCodeForFailMemory) {
    var busy = window.__SP.actions && window.__SP.actions.busy;

    var resp = await window.__SP.api.postJson('coupon', payload);

    if (!resp || resp.ok === false) {
      var serverCode = s(resp && resp.error);
      if (!serverCode) serverCode = 'coupon_failed';

      // Mark code as failed for 2 minutes only for "invalid-ish" apply errors
      if (mode === 'apply' && discountCodeForFailMemory) {
        if (
          serverCode === 'coupon_invalid_or_expired' ||
          serverCode === 'coupon_not_found' ||
          serverCode === 'coupon_apply_failed'
        ) {
          markFailed(discountCodeForFailMemory);
        }
      }

      var msg = toastForCouponError(serverCode);
      try {
        busy && busy.showToast(ui, msg, 'error');
      } catch (_) {}
      return { ok: false, error: serverCode, resp: resp };
    }

    // Success: clear any recorded failed memory for this code
    if (mode === 'apply' && discountCodeForFailMemory) clearFailed(discountCodeForFailMemory);

    return { ok: true, resp: resp };
  }

  var __inFlight = false;

  async function runCouponImpl(ui, input) {
    var busy = window.__SP.actions && window.__SP.actions.busy;
    if (!busy) throw new Error('busy_not_loaded');
    if (__inFlight) return { ok: false, error: 'busy' };

    input = input || {};
    var outerMode = s(input.mode);

    // If applying and there's an existing coupon, we will do a replace (remove then apply)
    var busyMsg = outerMode === 'remove' ? 'Removing coupon…' : 'Applying coupon…';

    __inFlight = true;

    try {
      return await busy.withBusy(
        ui,
        async function () {
          try {
            var mode = s(input.mode);
            var actionName = mode === 'remove' ? 'remove_coupon' : 'apply_coupon';
            if (mode !== 'apply' && mode !== 'remove') throw new Error('invalid_mode');

            trackAction(actionName, { status: 'attempt' });

            var contractGid = input.contractId;
            if (!contractGid) throw new Error('missing_contractId');

            var contractShortId = toNum(shortId(contractGid), 0);
            if (!contractShortId) throw new Error('missing_contractId');

            var contract = getContractFromCacheByGid(contractGid);
            if (!contract) throw new Error('cache_missing_contract');

            var discounts = getDiscountNodes(contract);
            var hasExisting = discounts && discounts.length > 0;

            var shop = pickOptionalShop();

            // ---- REMOVE MODE ---------------------------------------------------
            if (mode === 'remove') {
              if (!hasExisting) {
                try {
                  busy.showToast(ui, 'Coupon removed.', 'success');
                } catch (_) {}
                return {
                  ok: true,
                  contractId: contractShortId,
                  patch: { discounts: contract.discounts },
                };
              }

              var did = s(input.discountId);
              if (!did) {
                try {
                  did = s(discounts[0] && discounts[0].id);
                } catch (_) {}
              }
              if (!did) throw new Error('missing_discountId');

              var payloadR = { contractId: contractShortId, mode: 'remove', discountId: did };
              if (shop) payloadR.shop = shop;

              var r0 = await postCoupon(ui, payloadR, 'remove', null);
              if (!r0.ok) return { ok: false, error: r0.error };

              var patchR =
                r0.resp && r0.resp.patch && typeof r0.resp.patch === 'object' ? r0.resp.patch : {};
              var resultR = patchContractInCache(contractGid, patchR);
              if (!resultR.ok) {
                try {
                  console.warn('[coupon] cache patch failed:', resultR.error);
                } catch (e1) {}
              }

              refreshCurrentScreen();
              try {
                busy.showToast(ui, 'Coupon removed.', 'success');
              } catch (_) {}
              trackAction(actionName, { status: 'success' });
              trackActionResult(actionName, true);
              return { ok: true, contract: resultR.contract || null, patch: patchR };
            }

            // ---- APPLY MODE (with auto-replace) -------------------------------
            var discountCode = s(input.discountCode);
            if (!discountCode) throw new Error('missing_discountCode');

            // Anti-spam: if we recently saw this code fail, block immediately
            if (isRecentlyFailed(discountCode)) {
              var msg0 = 'Invalid or expired coupon code. Please try a different code.';
              try {
                busy.showToast(ui, msg0, 'error');
              } catch (_) {}
              return { ok: false, error: 'coupon_recently_failed' };
            }

            // If there is an existing discount, remove it first, then apply new code.
            // This eliminates the “remove it first” friction in the cancel flow.
            if (hasExisting) {
              // Update busy message if possible
              try {
                // Not all busy implementations support updating message; safe no-op.
                if (typeof busy.setMessage === 'function') busy.setMessage('Updating coupon…');
              } catch (_) {}

              var existingId = '';
              try {
                existingId = s(discounts[0] && discounts[0].id);
              } catch (_) {}
              if (!existingId) throw new Error('missing_discountId');

              var payloadRemove = {
                contractId: contractShortId,
                mode: 'remove',
                discountId: existingId,
              };
              if (shop) payloadRemove.shop = shop;

              var r1 = await postCoupon(ui, payloadRemove, 'remove', null);
              if (!r1.ok) return { ok: false, error: r1.error };

              var patch1 =
                r1.resp && r1.resp.patch && typeof r1.resp.patch === 'object' ? r1.resp.patch : {};
              var result1 = patchContractInCache(contractGid, patch1);
              if (!result1.ok) {
                try {
                  console.warn('[coupon] cache patch failed:', result1.error);
                } catch (e1a) {}
              }

              // refresh local contract reference for subsequent logic (optional)
              contract = result1.contract || contract;
            }

            var payloadA = {
              contractId: contractShortId,
              mode: 'apply',
              discountCode: discountCode,
            };
            if (shop) payloadA.shop = shop;

            var r2 = await postCoupon(ui, payloadA, 'apply', discountCode);
            if (!r2.ok) return { ok: false, error: r2.error };

            var patchA =
              r2.resp && r2.resp.patch && typeof r2.resp.patch === 'object' ? r2.resp.patch : {};
            var resultA = patchContractInCache(contractGid, patchA);
            if (!resultA.ok) {
              try {
                console.warn('[coupon] cache patch failed:', resultA.error);
              } catch (e1b) {}
            }

            refreshCurrentScreen();
            try {
              busy.showToast(ui, 'Coupon applied.', 'success');
            } catch (_) {}
            trackAction(actionName, { status: 'success' });
            trackActionResult(actionName, true);
            return { ok: true, contract: resultA.contract || null, patch: patchA };
          } catch (e) {
            trackAction(actionName, { status: 'error' });
            trackActionResult(actionName, false, {
              reason: toStr(e && e.message),
            });
            var code = String(e && e.message ? e.message : e);

            var msg = toastForCouponError(code);
            if (code === 'missing_discountCode') msg = 'Enter a coupon code.';
            if (code === 'invalid_mode') msg = 'Invalid request.';
            if (code === 'missing_contractId') msg = 'Missing subscription ID.';

            try {
              busy.showToast(ui, msg, 'error');
            } catch (_) {}
            return { ok: false, error: code };
          }
        },
        busyMsg
      );
    } finally {
      __inFlight = false;
    }
  }

  window.__SP.actions.coupon.run = function (ui, payload) {
    return runCouponImpl(ui, payload);
  };

  window.__SP.actions.coupon.apply = function (ui, contractGid, discountCode) {
    return runCouponImpl(ui, {
      mode: 'apply',
      contractId: contractGid,
      discountCode: discountCode,
    });
  };

  window.__SP.actions.coupon.remove = function (ui, contractGid, discountId) {
    return runCouponImpl(ui, { mode: 'remove', contractId: contractGid, discountId: discountId });
  };
})();
