// assets/portal-api.js
(function () {
  window.__SP = window.__SP || {};

  // ---- helpers -------------------------------------------------------------

  function log() {
    if (window.__SP && window.__SP.debug) {
      try { console.log.apply(console, arguments); } catch (e) {}
    }
  }

  function warn() {
    if (window.__SP && window.__SP.debug) {
      try { console.warn.apply(console, arguments); } catch (e) {}
    }
  }

  function shortId(gid) {
    var s = String(gid || "");
    if (!s) return "";
    var parts = s.split("/");
    return parts[parts.length - 1] || s;
  }

  function normalizeBaseEndpoint(input) {
    var s = String(input || "").trim();
    if (!s) return "/apps/portal";
    if (!s.startsWith("/")) s = "/" + s;
    return s.replace(/\/+$/, "") || "/apps/portal";
  }

  function buildUrl(base, route, params) {
    var sp = new URLSearchParams();
    sp.set("route", String(route || "").trim() || "bootstrap");

    if (params && typeof params === "object") {
      Object.keys(params).forEach(function (k) {
        var v = params[k];
        if (v === undefined || v === null) return;
        sp.set(k, String(v));
      });
    }

    return new URL(base + "?" + sp.toString(), window.location.origin).toString();
  }

  // ---- in-flight de-dupe (prevents parallel identical GETs) ----------------

  // Stored on window so multiple bundles/loads still share the same map.
  var __SP_INFLIGHT = window.__SP.__inflight = window.__SP.__inflight || {};

  function inflightKey(route, params) {
    var p = "";
    try { p = JSON.stringify(params || {}); } catch (e) { p = ""; }
    return String(route || "") + "|" + p;
  }

  // ---- cache ---------------------------------------------------------------

  var HOME_CACHE_KEY = "__sp_home_cache_v2";
  var SUBS_CACHE_KEY = "__sp_subscriptions_cache_v2";

  // Home can be short; it’s just a “is API alive” check
  var HOME_CACHE_TTL_MS = 60 * 1000; // 1 min

  // Subscriptions list should be longer (you’ll patch contracts in-place)
  var SUBS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

  function nowMs() { return Date.now(); }

  function readCache(key) {
    try {
      var raw = sessionStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function writeCache(key, data) {
    try {
      sessionStorage.setItem(key, JSON.stringify({ ts: nowMs(), data: data }));
    } catch (e) {}
  }

  function removeCache(key) {
    try { sessionStorage.removeItem(key); } catch (e) {}
  }

  function isFresh(entry, ttlMs) {
    return !!(entry && entry.ts && (nowMs() - entry.ts) < ttlMs);
  }

  function getFreshHome() {
    var entry = readCache(HOME_CACHE_KEY);
    if (!entry) return null;
    if (!isFresh(entry, HOME_CACHE_TTL_MS)) return null;
    return entry.data || null;
  }

  function getFreshSubscriptions() {
    var entry = readCache(SUBS_CACHE_KEY);
    if (!entry) return null;
    if (!isFresh(entry, SUBS_CACHE_TTL_MS)) return null;
    return entry.data || null;
  }

  function setHomeCache(data) { writeCache(HOME_CACHE_KEY, data); }
  function setSubscriptionsCache(data) { writeCache(SUBS_CACHE_KEY, data); }

  function clearCaches() {
    removeCache(HOME_CACHE_KEY);
    removeCache(SUBS_CACHE_KEY);
  }

  // ---- bucket + summary recompute (client-side) ----------------------------

  function bucketFromContract(c) {
    // Prefer backend portalState.bucket if present
    try {
      var b = c && c.portalState && c.portalState.bucket ? String(c.portalState.bucket) : "";
      b = b.toLowerCase();
      if (b === "active" || b === "paused" || b === "cancelled" || b === "failed" || b === "other") return b;
    } catch (e) {}

    // Fallback (should rarely happen): infer from status/lastPaymentStatus
    var status = String((c && c.status) || "").toUpperCase();
    var lps = String((c && c.lastPaymentStatus) || "").toUpperCase();

    if (status === "FAILED") return "failed";
    if (lps && lps !== "SUCCEEDED") return "failed";
    if (status === "CANCELLED") return "cancelled";
    if (status === "PAUSED") return "paused";
    if (status === "ACTIVE") return "active";
    return "other";
  }

  function rebuildBuckets(contracts) {
    var b = { active: [], paused: [], cancelled: [], failed: [], other: [] };
    (contracts || []).forEach(function (c) {
      var k = bucketFromContract(c);
      if (!b[k]) k = "other";
      b[k].push(c);
    });
    return b;
  }

  function rebuildSummary(contractIdsCount, contracts, failures) {
    var buckets = rebuildBuckets(contracts);
    return {
      total_ids: Number(contractIdsCount || 0) || 0,
      fetched_ok: (contracts || []).length,
      fetched_failed: (failures || []).length,
      active_count: buckets.active.length,
      paused_count: buckets.paused.length,
      cancelled_count: buckets.cancelled.length,
      failed_count: buckets.failed.length,
      other_count: buckets.other.length
    };
  }

  // Patch a single contract into the subscriptions cache payload
  function patchContractInSubscriptionsCache(updatedContract) {
    if (!updatedContract) return { ok: false, error: "missing_contract" };

    var sid = shortId(updatedContract.id);
    if (!sid) return { ok: false, error: "missing_contract_id" };

    var payload = getFreshSubscriptions();
    if (!payload || !payload.ok) return { ok: false, error: "no_subscriptions_cache" };

    var list = Array.isArray(payload.contracts) ? payload.contracts.slice() : [];
    var found = false;

    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c) continue;
      if (shortId(c.id) === sid) {
        list[i] = updatedContract;
        found = true;
        break;
      }
    }

    // If not found, append it (edge case: new contract appeared)
    if (!found) list.push(updatedContract);

    var failures = Array.isArray(payload.failures) ? payload.failures : [];
    var contractIdsCount = (payload.summary && payload.summary.total_ids != null)
      ? payload.summary.total_ids
      : list.length;

    var newBuckets = rebuildBuckets(list);
    var newSummary = rebuildSummary(contractIdsCount, list, failures);

    var nextPayload = Object.assign({}, payload, {
      contracts: list,
      buckets: newBuckets,
      summary: newSummary
    });

    setSubscriptionsCache(nextPayload);
    return { ok: true, found: found, contractId: sid };
  }

  // Read a single contract from subscriptions cache
  function getCachedContractById(contractIdOrGid) {
    var sid = shortId(contractIdOrGid);
    if (!sid) return null;

    var payload = getFreshSubscriptions();
    if (!payload || !payload.ok) return null;

    var list = Array.isArray(payload.contracts) ? payload.contracts : [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c) continue;
      if (shortId(c.id) === sid) return c;
    }
    return null;
  }

  // ---- network -------------------------------------------------------------

  async function fetchJson(route, params, opts) {
    opts = opts || {};
    var endpointRaw = window.__SP && window.__SP.endpoint;
    var base = normalizeBaseEndpoint(endpointRaw);

    var absUrl = buildUrl(base, route, params);
    log("[Portal API] FETCH:", absUrl);

    var res;
    try {
      // Force bypass browser/proxy caches (best-effort)
      res = await fetch(absUrl, {
        method: opts.method || "GET",
        credentials: "include",
        cache: "no-store",
        headers: Object.assign(
          { Accept: "application/json", "Cache-Control": "no-cache" },
          opts.headers || {}
        ),
        body: opts.body || undefined
      });
    } catch (e) {
      warn("[Portal API] Fetch failed:", e);
      throw e;
    }

    var ct = (res.headers.get("content-type") || "").toLowerCase();
    var bodyText = await res.text();
    var data = null;

    if (ct.indexOf("application/json") >= 0) {
      try { data = bodyText ? JSON.parse(bodyText) : null; }
      catch (e) { data = null; }
    } else {
      data = bodyText;
    }

    if (!res.ok) {
      warn("[Portal API] Non-OK:", res.status, data);
      var err = new Error("HTTP_" + res.status);
      err.status = res.status;
      err.details = data;
      throw err;
    }

    return data;
  }

  // ---- public API ----------------------------------------------------------

  async function requestJson(route, params, opts) {
    opts = opts || {};
    params = params || {};
    route = String(route || "").toLowerCase();
    var force = !!opts.force;

    // De-dupe ONLY GETs (so actions/POSTs are never coalesced)
    var method = String(opts.method || "GET").toUpperCase();
    var canDedupe = method === "GET";

    // If we can de-dupe, coalesce identical in-flight GETs for this route+params.
    if (canDedupe) {
      var ikey = inflightKey(route, params);
      if (__SP_INFLIGHT[ikey]) {
        log("[Portal API] IN-FLIGHT HIT:", route);
        return __SP_INFLIGHT[ikey];
      }

      __SP_INFLIGHT[ikey] = (async function () {
        try {
          // 1) HOME: short cache
          if (route === "home" && !force) {
            var cachedHome = getFreshHome();
            if (cachedHome) {
              log("[Portal API] HOME CACHE HIT");
              return cachedHome;
            }
          }

          // 2) SUBSCRIPTIONS: 10-min cache
          if (route === "subscriptions" && !force) {
            var cachedSubs = getFreshSubscriptions();
            if (cachedSubs) {
              log("[Portal API] SUBSCRIPTIONS CACHE HIT");
              return cachedSubs;
            }
          }

          // Network
          var data = await fetchJson(route, params, opts);

          // Cache writes (only for these routes)
          if (route === "home" && data && data.ok) {
            setHomeCache(data);
            log("[Portal API] HOME CACHE UPDATED");
          }

          if (route === "subscriptions" && data && data.ok) {
            setSubscriptionsCache(data);
            log("[Portal API] SUBSCRIPTIONS CACHE UPDATED");
          }

          return data;
        } finally {
          try { delete __SP_INFLIGHT[ikey]; } catch (e) {}
        }
      })();

      return __SP_INFLIGHT[ikey];
    }

    // Non-deduped path (POST/etc.)
    // 1) HOME: short cache
    if (route === "home" && !force) {
      var cachedHome2 = getFreshHome();
      if (cachedHome2) {
        log("[Portal API] HOME CACHE HIT");
        return cachedHome2;
      }
    }

    // 2) SUBSCRIPTIONS: 10-min cache
    if (route === "subscriptions" && !force) {
      var cachedSubs2 = getFreshSubscriptions();
      if (cachedSubs2) {
        log("[Portal API] SUBSCRIPTIONS CACHE HIT");
        return cachedSubs2;
      }
    }

    var data2 = await fetchJson(route, params, opts);

    if (route === "home" && data2 && data2.ok) {
      setHomeCache(data2);
      log("[Portal API] HOME CACHE UPDATED");
    }

    if (route === "subscriptions" && data2 && data2.ok) {
      setSubscriptionsCache(data2);
      log("[Portal API] SUBSCRIPTIONS CACHE UPDATED");
    }

    return data2;
  }

  async function postJson(route, payload, params) {
    var headers = { "Content-Type": "application/json" };
    return await requestJson(route, params || {}, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload || {})
    });
  }

  async function request(route, params, opts) {
    return await requestJson(route, params, opts);
  }

  // ---- exports -------------------------------------------------------------

  window.__SP.api = {
    requestJson: requestJson,
    postJson: postJson,
    request: request,

    clearCaches: clearCaches,

    // Cache getters
    getFreshHomeData: getFreshHome,
    getFreshSubscriptionsData: getFreshSubscriptions,

    // Contract cache helpers (for subscription detail + actions)
    getCachedContractById: getCachedContractById,
    patchContractInSubscriptionsCache: patchContractInSubscriptionsCache
  };

  log("[Portal API] Loaded. window.__SP.api is ready.");
})();