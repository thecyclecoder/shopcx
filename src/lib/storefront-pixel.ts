"use client";

/**
 * Storefront pixel client lib. Loaded on every public PDP, customize,
 * checkout, and thank-you page. Single dependency: the browser. No
 * third-party SDK.
 *
 * What it does:
 *   - Mints/reads the `sid` cookie (anonymous_id, UUID v4, first-party,
 *     365 day expiry, SameSite=Lax). One per browser per workspace.
 *   - On first call per page, captures the landing-touch attribution
 *     payload into sessionStorage so the same session carries UTMs,
 *     ad-network click IDs, and Meta cookies through to checkout — not
 *     just the first event.
 *   - Exposes `track(eventType, meta?)` which queues events into a
 *     small in-memory buffer and flushes to /api/pixel on a 500 ms
 *     window. Critical events (order_placed) flush immediately.
 *   - Exposes `identify(customerId)` which sets the cookie's
 *     customer_id link so subsequent events stitch.
 *   - On `pagehide`, flushes via navigator.sendBeacon so we don't
 *     drop the last batch when the customer navigates away.
 *
 * What it does NOT do:
 *   - No retry. The endpoint is upsert-with-ignore-duplicates so a
 *     client retry would be safe, but reliability isn't this lib's
 *     job — the events are funnel telemetry, not financial records.
 *   - No "pageview" autofire. Callers explicitly fire pdp_view (or
 *     customize_view, checkout_view, etc.) from each page so we
 *     stay in control of what counts as which step.
 */

const COOKIE_NAME = "sid";
const COOKIE_DAYS = 365;
const FLUSH_INTERVAL_MS = 500;
const SESSION_STORAGE_KEY = "shopcx_session_ctx";
const PIXEL_PATH = "/api/pixel";

type EventMeta = Record<string, unknown>;

interface QueuedEvent {
  event_id: string;
  event_type: string;
  product_id?: string;
  meta?: EventMeta;
  url?: string;
}

interface SessionContext {
  landing_url?: string;
  referrer?: string;
  viewport_width?: number;
  viewport_height?: number;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  fbclid?: string;
  gclid?: string;
  ttclid?: string;
  fbp?: string;
  fbc?: string;
}

let workspaceId: string | null = null;
let queue: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let listenersBound = false;
let customerId: string | null = null;

/**
 * Initialize the pixel for the current page. Must be called once per
 * page (typically from a top-level layout effect) BEFORE any track()
 * calls. Idempotent — calling repeatedly is safe; only the first call
 * captures attribution.
 */
export function initPixel(opts: { workspaceId: string; customerId?: string | null }) {
  if (typeof window === "undefined") return;
  workspaceId = opts.workspaceId;
  if (opts.customerId) customerId = opts.customerId;

  // Ensure anonymous_id cookie exists. Side-effect of getOrCreate.
  getOrCreateAnonymousId();

  // Capture first-touch attribution into sessionStorage if not already.
  if (!sessionStorage.getItem(SESSION_STORAGE_KEY)) {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(buildSessionContext()));
  }

  if (!listenersBound) {
    listenersBound = true;
    window.addEventListener("pagehide", flushBeacon);
    // Some browsers fire visibilitychange before pagehide; belt + suspenders.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushBeacon();
    });
  }
}

/**
 * Queue an event. The default flush window is 500ms. order_placed
 * flushes immediately to maximize delivery before navigation.
 */
export function track(eventType: string, meta?: EventMeta) {
  if (typeof window === "undefined" || !workspaceId) return;

  const event: QueuedEvent = {
    event_id: crypto.randomUUID(),
    event_type: eventType,
    meta,
    url: window.location.href,
  };
  // product_id is a top-level field on storefront_events; let callers
  // pass it via meta and we'll lift it.
  if (meta && typeof meta.product_id === "string") {
    event.product_id = meta.product_id;
  }
  queue.push(event);

  if (eventType === "order_placed") {
    flushSync();
  } else {
    scheduleFlush();
  }
}

/**
 * Stitch the current session to a known customer_id. Called from
 * lead capture flow or checkout success. Subsequent events carry
 * the customer_id; prior events get backfilled server-side by the
 * lead/checkout endpoints, not by the pixel.
 */
export function identify(id: string) {
  customerId = id;
  // Force a session_context refresh so the next batch carries the new
  // customer_id field through to /api/pixel.
}

/**
 * Read the current anonymous_id (for cases like the customize page
 * needing to pass it to /api/cart). Always defined post-initPixel.
 */
export function getAnonymousId(): string | null {
  if (typeof document === "undefined") return null;
  return getOrCreateAnonymousId();
}

// ─── internals ─────────────────────────────────────────────────────

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
}

function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (queue.length === 0 || !workspaceId) return;
  const events = queue;
  queue = [];

  const payload = JSON.stringify({
    workspace_id: workspaceId,
    anonymous_id: getOrCreateAnonymousId(),
    customer_id: customerId,
    events,
    session_context: getSessionContext(),
  });

  // Fire-and-forget POST. keepalive lets the request survive a
  // page-navigation race when not using sendBeacon.
  fetch(PIXEL_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
    credentials: "same-origin",
  }).catch(() => { /* swallow — pixel is best-effort */ });
}

function flushSync() {
  flush();
}

/**
 * pagehide / visibilitychange handler. sendBeacon is more reliable
 * than fetch during unload — the browser commits to delivering even
 * after we're navigated away. Browser caps the payload at ~64KB
 * which is far more than our small event batches.
 */
function flushBeacon() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (queue.length === 0 || !workspaceId) return;
  const events = queue;
  queue = [];

  const payload = JSON.stringify({
    workspace_id: workspaceId,
    anonymous_id: getOrCreateAnonymousId(),
    customer_id: customerId,
    events,
    session_context: getSessionContext(),
  });

  try {
    const blob = new Blob([payload], { type: "application/json" });
    navigator.sendBeacon(PIXEL_PATH, blob);
  } catch {
    // Older browsers, no sendBeacon — fall back to fire-and-forget fetch.
    fetch(PIXEL_PATH, {
      method: "POST",
      body: payload,
      headers: { "Content-Type": "application/json" },
      keepalive: true,
    }).catch(() => {});
  }
}

function getOrCreateAnonymousId(): string {
  const existing = readCookie(COOKIE_NAME);
  if (existing) return existing;
  const id = crypto.randomUUID();
  writeCookie(COOKIE_NAME, id, COOKIE_DAYS);
  return id;
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.split("; ").find((row) => row.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function writeCookie(name: string, value: string, days: number) {
  const expires = new Date(Date.now() + days * 86_400_000).toUTCString();
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${name}=${encodeURIComponent(value)}; Expires=${expires}; Path=/; SameSite=Lax${secure}`;
}

/**
 * Build session context from the current URL + document.referrer + a
 * scan of document.cookie for Meta's _fbp / _fbc cookies. Called once
 * per session (first initPixel) and frozen into sessionStorage so
 * later events on the same tab carry the same attribution.
 */
function buildSessionContext(): SessionContext {
  const url = new URL(window.location.href);
  const ctx: SessionContext = {
    landing_url: window.location.href,
    referrer: document.referrer || undefined,
    viewport_width: window.innerWidth,
    viewport_height: window.innerHeight,
  };

  const utmKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
  for (const k of utmKeys) {
    const v = url.searchParams.get(k);
    if (v) (ctx as Record<string, unknown>)[k] = v;
  }

  const fbclid = url.searchParams.get("fbclid");
  const gclid = url.searchParams.get("gclid");
  const ttclid = url.searchParams.get("ttclid");
  if (fbclid) ctx.fbclid = fbclid;
  if (gclid) ctx.gclid = gclid;
  if (ttclid) ctx.ttclid = ttclid;

  // Read Meta browser cookies if Facebook's pixel happens to be on
  // the page (rare for us since we own this layer, but compatible).
  const fbp = readCookie("_fbp");
  const fbc = readCookie("_fbc");
  if (fbp) ctx.fbp = fbp;
  if (fbc) ctx.fbc = fbc;

  return ctx;
}

function getSessionContext(): SessionContext {
  try {
    const stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (stored) return JSON.parse(stored) as SessionContext;
  } catch {
    /* fall through */
  }
  return buildSessionContext();
}
