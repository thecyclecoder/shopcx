// core/api.js — Portal API client (ES module)
// Caching, in-flight deduplication, contract cache patching

const HOME_CACHE_KEY = '__sp_home_cache_v2';
const SUBS_CACHE_KEY = '__sp_subscriptions_cache_v2';
const HOME_CACHE_TTL = 60 * 1000;
const SUBS_CACHE_TTL = 10 * 60 * 1000;

let _endpoint = '/apps/portal';
let _debug = false;
const _inflight = {};

export function configure(opts) {
  if (opts.endpoint) _endpoint = opts.endpoint.replace(/\/+$/, '') || '/apps/portal';
  if (opts.debug != null) _debug = !!opts.debug;
}

function log(...args) { if (_debug) console.log('[Portal API]', ...args); }

function buildUrl(route, params) {
  const sp = new URLSearchParams();
  sp.set('route', route || 'bootstrap');
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v != null) sp.set(k, String(v));
    }
  }
  return new URL(_endpoint + '?' + sp.toString(), window.location.origin).toString();
}

// ---- Session cache ----

function readCache(key) {
  try { const r = sessionStorage.getItem(key); return r ? JSON.parse(r) : null; } catch { return null; }
}
function writeCache(key, data) {
  try { sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch {}
}
function isFresh(entry, ttl) {
  return !!(entry?.ts && (Date.now() - entry.ts) < ttl);
}

export function getFreshHome() {
  const e = readCache(HOME_CACHE_KEY);
  return e && isFresh(e, HOME_CACHE_TTL) ? e.data : null;
}
export function getFreshSubscriptions() {
  const e = readCache(SUBS_CACHE_KEY);
  return e && isFresh(e, SUBS_CACHE_TTL) ? e.data : null;
}
export function clearCaches() {
  try { sessionStorage.removeItem(HOME_CACHE_KEY); } catch {}
  try { sessionStorage.removeItem(SUBS_CACHE_KEY); } catch {}
}

// ---- Network ----

async function fetchJson(route, params, opts = {}) {
  const url = buildUrl(route, params);
  log('FETCH:', url);

  const res = await fetch(url, {
    method: opts.method || 'GET',
    credentials: 'include',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
      ...(opts.headers || {}),
    },
    body: opts.body || undefined,
  });

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const text = await res.text();
  let data = null;

  if (ct.includes('application/json')) {
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  } else {
    data = text;
  }

  if (!res.ok) {
    const err = new Error('HTTP_' + res.status);
    err.status = res.status;
    err.details = data;
    throw err;
  }

  return data;
}

// ---- Public API ----

export async function requestJson(route, params = {}, opts = {}) {
  route = (route || '').toLowerCase();
  const force = !!opts.force;
  const method = (opts.method || 'GET').toUpperCase();
  const canDedupe = method === 'GET';

  // Cache check
  if (!force) {
    if (route === 'home') { const c = getFreshHome(); if (c) { log('HOME CACHE HIT'); return c; } }
    if (route === 'subscriptions') { const c = getFreshSubscriptions(); if (c) { log('SUBS CACHE HIT'); return c; } }
  }

  // De-dupe GETs
  if (canDedupe) {
    const key = route + '|' + JSON.stringify(params);
    if (_inflight[key]) return _inflight[key];

    _inflight[key] = (async () => {
      try {
        const data = await fetchJson(route, params, opts);
        if (route === 'home' && data?.ok) { writeCache(HOME_CACHE_KEY, data); }
        if (route === 'subscriptions' && data?.ok) { writeCache(SUBS_CACHE_KEY, data); }
        return data;
      } finally {
        delete _inflight[key];
      }
    })();
    return _inflight[key];
  }

  const data = await fetchJson(route, params, opts);
  if (route === 'home' && data?.ok) writeCache(HOME_CACHE_KEY, data);
  if (route === 'subscriptions' && data?.ok) writeCache(SUBS_CACHE_KEY, data);
  return data;
}

export async function postJson(route, payload, params) {
  return requestJson(route, params || {}, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
}

// ---- Contract cache helpers ----

export function getCachedContractById(id) {
  if (!id) return null;
  const sid = String(id).split('/').pop();
  const payload = getFreshSubscriptions();
  if (!payload?.ok || !Array.isArray(payload.contracts)) return null;
  return payload.contracts.find(c => c?.id && String(c.id).split('/').pop() === sid) || null;
}

export function patchContractInCache(updated) {
  if (!updated) return;
  const sid = String(updated.id || '').split('/').pop();
  if (!sid) return;

  const payload = getFreshSubscriptions();
  if (!payload?.ok) return;

  const list = [...(payload.contracts || [])];
  const idx = list.findIndex(c => c?.id && String(c.id).split('/').pop() === sid);
  if (idx >= 0) list[idx] = updated;
  else list.push(updated);

  writeCache(SUBS_CACHE_KEY, { ...payload, contracts: list });
}
