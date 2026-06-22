// core/error-reporter.js — client-side error capture for the portal (Preact bundle).
//
// The browser-side half of the MISSING FOURTH error feed (client-error-capture
// spec, Phase 1). Posts uncaught JS errors / unhandled promise rejections / a
// failed render to the public /api/client-errors ingest → Control Tower "Client
// errors" panel, surface 'portal'.
//
// This portal runs cross-origin from the app (Shopify storefront domain via app
// proxy, or a branded mini-site domain), so we POST to the ABSOLUTE app origin
// (__APP_ORIGIN__, injected at build time) with a text/plain sendBeacon — a
// CORS-safelisted "simple" request, no preflight, survives page unload.
//
// Hard rules: FAIL-OPEN (never throws, never blocks the portal) and NO PII (the
// path only — query strings stripped; no form values / tokens).

const APP_ORIGIN = typeof __APP_ORIGIN__ !== 'undefined' ? __APP_ORIGIN__ : 'https://shopcx.ai';
const INGEST = APP_ORIGIN.replace(/\/+$/, '') + '/api/client-errors';
const SURFACE = 'portal';
const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;
const DEDUP_WINDOW_MS = 30000;

const _recent = {}; // signature → last-sent epoch ms (client-side spam throttle)

function sanitizePage() {
  try {
    return (window.location.pathname || '/').split('?')[0].split('#')[0].slice(0, 300) || '/';
  } catch {
    return '/';
  }
}

function post(body) {
  try {
    const json = JSON.stringify(body);
    if (navigator && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([json], { type: 'text/plain;charset=UTF-8' });
      if (navigator.sendBeacon(INGEST, blob)) return;
    }
    if (typeof fetch === 'function') {
      fetch(INGEST, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: json,
        keepalive: true,
        mode: 'no-cors',
        credentials: 'omit',
      }).catch(() => {});
    }
  } catch {
    // Fail-open.
  }
}

function report(message, stack) {
  try {
    const msg = String(message || 'Unknown client error').slice(0, MAX_MESSAGE);
    const sig = SURFACE + '|' + msg;
    const now = Date.now();
    if (_recent[sig] && now - _recent[sig] < DEDUP_WINDOW_MS) return;
    _recent[sig] = now;
    post({
      surface: SURFACE,
      page: sanitizePage(),
      message: msg,
      stack: stack ? String(stack).slice(0, MAX_STACK) : null,
      userAgent: navigator ? navigator.userAgent : null,
    });
  } catch {
    // Fail-open.
  }
}

// A per-session "we're alive" beat so the Control Tower panel can read green
// "connected" instead of amber "awaiting first event" without needing a crash.
function heartbeat() {
  try {
    const key = '__cx_client_err_hb';
    if (typeof sessionStorage !== 'undefined') {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    }
    post({ heartbeat: true, surface: SURFACE });
  } catch {
    // Fail-open.
  }
}

let _installed = false;

// Install the global window listeners + send the liveness heartbeat. Idempotent.
export function installPortalErrorReporter() {
  if (_installed || typeof window === 'undefined') return;
  _installed = true;
  try {
    window.addEventListener('error', (e) => {
      const err = e && e.error;
      report((err && err.message) || (e && e.message) || 'window.onerror', err && err.stack);
    });
    window.addEventListener('unhandledrejection', (e) => {
      const r = e && e.reason;
      const message = r instanceof Error ? r.message : typeof r === 'string' ? r : 'unhandledrejection';
      report('Unhandled rejection: ' + message, r instanceof Error ? r.stack : null);
    });
    heartbeat();
  } catch {
    // Fail-open.
  }
}

// Report a render crash caught by the App-level boundary. Exported for App.jsx.
export function reportPortalCrash(error) {
  report((error && error.message) || 'Portal render crash', error && error.stack);
}
