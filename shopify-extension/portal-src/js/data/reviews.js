// assets/data/reviews.js
(function () {
  window.__SP = window.__SP || {};
  window.__SP.data = window.__SP.data || {};

  // ---------------------------------------------------------------------------
  // Reviews data store (GET-only)
  //
  // - Calls: /apps/portal?route=reviews&productIds=123,456
  // - Persistent cache in localStorage (by productId) with TTL (default 1 day)
  // - In-memory cache + in-flight de-dupe
  // - Stores reviews per productId (Shopify numeric product id)
  // ---------------------------------------------------------------------------

  function log() {
    if (window.__SP && window.__SP.debug) {
      try {
        console.log.apply(console, arguments);
      } catch (e) {}
    }
  }

  function warn() {
    if (window.__SP && window.__SP.debug) {
      try {
        console.warn.apply(console, arguments);
      } catch (e) {}
    }
  }

  function safeStr(v) {
    return typeof v === 'string' ? v : v == null ? '' : String(v);
  }

  function nowMs() {
    return Date.now();
  }

  function shortId(gidOrId) {
    var s = safeStr(gidOrId).trim();
    if (!s) return '';
    var parts = s.split('/');
    return (parts[parts.length - 1] || s).trim();
  }

  function normalizeProductId(input) {
    // Accept:
    // - "123"
    // - 123
    // - "gid://shopify/Product/123"
    var sid = shortId(input);
    if (!sid) return '';
    var digits = sid.replace(/[^\d]/g, '');
    return (digits || sid).trim();
  }

  function uniqKeepOrder(arr) {
    var seen = {};
    var out = [];
    for (var i = 0; i < (arr || []).length; i++) {
      var v = safeStr(arr[i]).trim();
      if (!v) continue;
      if (seen[v]) continue;
      seen[v] = 1;
      out.push(v);
    }
    return out;
  }

  function normalizeProductIds(inputs) {
    var list = Array.isArray(inputs) ? inputs : inputs == null ? [] : [inputs];
    var normalized = [];
    for (var i = 0; i < list.length; i++) {
      var pid = normalizeProductId(list[i]);
      if (pid) normalized.push(pid);
    }
    return uniqKeepOrder(normalized);
  }

  function makeSetKey(productIds) {
    // Stable key for in-flight de-dupe (order-independent)
    var ids = (productIds || []).slice().sort();
    return ids.join(',');
  }

  // ---------------------------------------------------------------------------
  // Persistent cache (localStorage)
  // ---------------------------------------------------------------------------

  var STORAGE_KEY = '__sp_reviews_cache_v1';
  var REVIEWS_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
  var MAX_PRODUCTS_STORED = 200; // guardrail
  var MAX_STORAGE_BYTES_APPROX = 350000; // soft guardrail (~350KB)

  function storageAvailable() {
    try {
      var k = '__sp_test__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  }

  function readStorage() {
    if (!storageAvailable()) return null;
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (!parsed.byProductId || typeof parsed.byProductId !== 'object') return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function writeStorage(obj) {
    if (!storageAvailable()) return false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  }

  function approxSizeBytes(obj) {
    try {
      return JSON.stringify(obj).length;
    } catch (e) {
      return 0;
    }
  }

  function pruneStorageObject(cacheObj) {
    // cacheObj: { byProductId: { pid: {ts, ok, reviews, error?} } }
    if (!cacheObj || typeof cacheObj !== 'object') return { byProductId: {} };
    var map =
      cacheObj.byProductId && typeof cacheObj.byProductId === 'object' ? cacheObj.byProductId : {};
    var now = nowMs();

    // 1) Remove expired entries
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i++) {
      var pid = keys[i];
      var e = map[pid];
      var ts = e && typeof e.ts === 'number' ? e.ts : 0;
      if (!ts || now - ts > REVIEWS_TTL_MS) {
        try {
          delete map[pid];
        } catch (e1) {}
      }
    }

    // 2) Enforce MAX_PRODUCTS_STORED (drop oldest)
    keys = Object.keys(map);
    if (keys.length > MAX_PRODUCTS_STORED) {
      keys.sort(function (a, b) {
        var ta = map[a] && typeof map[a].ts === 'number' ? map[a].ts : 0;
        var tb = map[b] && typeof map[b].ts === 'number' ? map[b].ts : 0;
        return ta - tb; // oldest first
      });
      var toDrop = keys.length - MAX_PRODUCTS_STORED;
      for (var d = 0; d < toDrop; d++) {
        try {
          delete map[keys[d]];
        } catch (e2) {}
      }
    }

    // 3) Soft cap on storage size (drop oldest until under cap)
    var size = approxSizeBytes({ byProductId: map });
    if (size > MAX_STORAGE_BYTES_APPROX) {
      keys = Object.keys(map);
      keys.sort(function (a, b) {
        var ta = map[a] && typeof map[a].ts === 'number' ? map[a].ts : 0;
        var tb = map[b] && typeof map[b].ts === 'number' ? map[b].ts : 0;
        return ta - tb;
      });

      for (var j = 0; j < keys.length && size > MAX_STORAGE_BYTES_APPROX; j++) {
        try {
          delete map[keys[j]];
        } catch (e3) {}
        size = approxSizeBytes({ byProductId: map });
      }
    }

    return { byProductId: map };
  }

  function clearCache() {
    try {
      if (storageAvailable()) localStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
    try {
      _byProductId = {};
    } catch (e2) {}
  }

  // ---------------------------------------------------------------------------
  // In-memory state
  // ---------------------------------------------------------------------------

  var _byProductId = {};
  var _inflight = {};
  var _subs = [];

  function emit(evt) {
    for (var i = 0; i < _subs.length; i++) {
      try {
        _subs[i](evt);
      } catch (e) {}
    }
  }

  function isFresh(entry, ttlMs) {
    // IMPORTANT:
    // - Failures (ok:false) should NEVER be treated as fresh.
    //   Otherwise one transient Klaviyo error would suppress retries for 1 day.
    if (!entry || !entry.ts) return false;
    if (entry.ok === false) return false;
    return nowMs() - entry.ts < (ttlMs || REVIEWS_TTL_MS);
  }

  function hydrateFromStorage() {
    var st = readStorage();
    if (!st) return;

    // Prune on read
    var pruned = pruneStorageObject(st);

    // Write back if pruning changed anything materially
    try {
      writeStorage(pruned);
    } catch (e) {}

    var map = pruned.byProductId || {};
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i++) {
      var pid = normalizeProductId(keys[i]);
      if (!pid) continue;
      var e = map[keys[i]];
      if (!e || typeof e !== 'object') continue;

      _byProductId[pid] = {
        ts: typeof e.ts === 'number' ? e.ts : 0,
        ok: e.ok === true,
        reviews: Array.isArray(e.reviews) ? e.reviews : [],
        error:
          e.ok === false
            ? e.error || { code: 'reviews_error', message: 'Reviews unavailable' }
            : undefined,
      };
    }

    log('[Reviews] Hydrated from localStorage:', keys.length, 'products');
  }

  function persistProducts(productIds) {
    // Merge specific productIds from memory into storage (and prune).
    // IMPORTANT:
    // - We do NOT persist ok:false entries to avoid poisoning cache for 1 day.
    if (!storageAvailable()) return;

    try {
      var st = readStorage() || { byProductId: {} };
      if (!st.byProductId || typeof st.byProductId !== 'object') st.byProductId = {};

      for (var i = 0; i < productIds.length; i++) {
        var pid = normalizeProductId(productIds[i]);
        if (!pid) continue;
        var mem = _byProductId[pid];
        if (!mem) continue;

        // Only persist entries with ts (we set ts on upsert)
        if (!mem.ts) continue;

        // ✅ Do not persist failures
        if (mem.ok !== true) continue;

        st.byProductId[pid] = {
          ts: mem.ts,
          ok: true,
          reviews: Array.isArray(mem.reviews) ? mem.reviews : [],
          error: null,
        };
      }

      st = pruneStorageObject(st);
      writeStorage(st);
    } catch (e) {
      // Ignore persistence failures (quota, privacy mode, etc.)
    }
  }

  // hydrate immediately on load
  hydrateFromStorage();

  function getEntry(productId) {
    var pid = normalizeProductId(productId);
    if (!pid) return null;
    return _byProductId[pid] || null;
  }

  function getReviews(productId) {
    var e = getEntry(productId);
    if (!e || e.ok !== true) return [];
    return Array.isArray(e.reviews) ? e.reviews : [];
  }

  function hasReviews(productId) {
    var r = getReviews(productId);
    return !!(r && r.length);
  }

  function getError(productId) {
    var e = getEntry(productId);
    if (!e || e.ok !== false) return null;
    return e.error || { code: 'unknown_error', message: 'Unknown error' };
  }

  function upsertFromResponse(productIds, resp) {
    var now = nowMs();
    var map = resp && (resp.by_product_id || resp.byProductId);
    if (!map || typeof map !== 'object') map = {};

    for (var i = 0; i < productIds.length; i++) {
      var pid = productIds[i];
      var rec = map[pid];

      if (rec && rec.ok === true) {
        _byProductId[pid] = {
          ts: now,
          ok: true,
          reviews: Array.isArray(rec.reviews) ? rec.reviews : [],
        };
      } else if (rec && rec.ok === false) {
        // Keep failures in memory for debugging, but they won't be "fresh"
        _byProductId[pid] = {
          ts: now,
          ok: false,
          reviews: [],
          error: rec.error || { code: 'reviews_error', message: 'Reviews unavailable' },
        };
      } else {
        _byProductId[pid] = {
          ts: now,
          ok: true,
          reviews: [],
        };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Fetch orchestration
  // ---------------------------------------------------------------------------

  async function fetchFeatured(productIds, opts) {
    opts = opts || {};
    var ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : REVIEWS_TTL_MS;
    var force = !!opts.force;

    var ids = normalizeProductIds(productIds);
    if (!ids.length) {
      return { ok: true, product_ids: [], by_product_id: {} };
    }

    var MAX_PRODUCTS_PER_CALL = 50;
    if (ids.length > MAX_PRODUCTS_PER_CALL) {
      ids = ids.slice(0, MAX_PRODUCTS_PER_CALL);
    }

    // If not forcing, and everything is fresh, short-circuit
    if (!force) {
      var allFresh = true;
      for (var i = 0; i < ids.length; i++) {
        var e = _byProductId[ids[i]];
        if (!isFresh(e, ttlMs)) {
          allFresh = false;
          break;
        }
      }
      if (allFresh) {
        log('[Reviews] Cache hit (memory/localStorage) for all products:', ids.length);
        return { ok: true, product_ids: ids, by_product_id: snapshotByProductId(ids) };
      }
    }

    var setKey = makeSetKey(ids);

    if (_inflight[setKey]) {
      log('[Reviews] In-flight hit:', setKey);
      return _inflight[setKey];
    }

    _inflight[setKey] = (async function () {
      try {
        if (!window.__SP.api || typeof window.__SP.api.requestJson !== 'function') {
          return {
            ok: false,
            error: 'missing_api',
            message: 'window.__SP.api.requestJson is not available',
          };
        }

        var resp = await window.__SP.api.requestJson('reviews', {
          productIds: ids.join(','),
        });

        if (!resp || resp.ok !== true) {
          return resp || { ok: false, error: 'reviews_error' };
        }

        upsertFromResponse(ids, resp);

        // Persist only successful products
        persistProducts(ids);

        emit({
          type: 'reviews:updated',
          productIds: ids.slice(),
          byProductId: snapshotByProductId(ids),
        });

        return resp;
      } catch (e) {
        warn('[Reviews] Fetch failed:', e);
        return {
          ok: false,
          error: 'network_error',
          message: e && e.message ? e.message : 'network_error',
        };
      } finally {
        try {
          delete _inflight[setKey];
        } catch (e2) {}
      }
    })();

    return _inflight[setKey];
  }

  function snapshotByProductId(productIds) {
    var out = {};
    for (var i = 0; i < (productIds || []).length; i++) {
      var pid = normalizeProductId(productIds[i]);
      if (!pid) continue;
      var e = _byProductId[pid];
      if (!e) continue;
      out[pid] = {
        ok: e.ok === true,
        reviews: Array.isArray(e.reviews) ? e.reviews.slice() : [],
        error: e.ok === false ? e.error || null : null,
        ts: e.ts || 0,
      };
    }
    return out;
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    _subs.push(fn);
    return function unsubscribe() {
      try {
        var idx = _subs.indexOf(fn);
        if (idx >= 0) _subs.splice(idx, 1);
      } catch (e) {}
    };
  }

  // ---------------------------------------------------------------------------
  // Public exports
  // ---------------------------------------------------------------------------

  window.__SP.data.reviews = {
    fetchFeatured: fetchFeatured,

    getEntry: getEntry,
    getReviews: getReviews,
    hasReviews: hasReviews,
    getError: getError,

    subscribe: subscribe,

    // Helpful during rollout/testing
    clearCache: clearCache,

    _debugSnapshot: function () {
      return {
        keys: Object.keys(_byProductId),
        inflightKeys: Object.keys(_inflight),
        storageKey: STORAGE_KEY,
        ttlMs: REVIEWS_TTL_MS,
      };
    },
  };

  log('[Reviews] Loaded. window.__SP.data.reviews is ready.');
})();
