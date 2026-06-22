/**
 * Client-side error reporter (client-error-capture spec, Phase 1).
 *
 * The browser-side half of the MISSING FOURTH error feed. Vercel's log drain
 * only sees SERVER-side errors — an SSR crash, an API 500. Client-side JS that
 * breaks the UX in the user's browser (a React render crash, an unhandled
 * promise rejection, a Braintree widget failing on checkout) is invisible to
 * us. This module collects those and ships them to the public /api/client-errors
 * ingest, which folds them into the Control Tower error feed (source 'client').
 *
 * Two hard rules (untrusted, in the user's browser):
 *   - FAIL-OPEN: the reporter NEVER blocks rendering and NEVER throws — a failed
 *     report is silently dropped. The page must not break worse trying to report
 *     a break.
 *   - NO PII: we capture the error message/stack and the page PATH only. Query
 *     strings (which may carry tokens) are stripped; form values / tokens /
 *     customer data are never read.
 *
 * Client-side dedup throttles a flapping error so we don't spam the ingest; the
 * server dedups again by signature (one error_events incident, count bumps).
 *
 * Pure (no React) so the Next surfaces AND the in-house portal can share it; the
 * Shopify-extension Preact portal has its own tiny copy (it's a separate bundle).
 *
 * See docs/brain/specs/client-error-capture.md · docs/brain/libraries/client-error-reporter.md.
 */

/** The capture surface — matches the error_events grouping the Control Tower panel reads. */
export type ClientErrorSurface =
  | "storefront-pdp"
  | "storefront-customize"
  | "checkout"
  | "thank-you"
  | "portal"
  | "storefront";

const INGEST_PATH = "/api/client-errors";
const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;
const MAX_PAGE = 300;
/** Drop a repeat of the same (surface+message) signature within this window (client-side dedup). */
const DEDUP_WINDOW_MS = 30_000;

/** Map a pathname to the capture surface. Portal paths win; then the storefront funnel steps. */
export function classifySurface(pathname: string | null | undefined): ClientErrorSurface {
  const p = (pathname || "").toLowerCase();
  if (p.includes("/portal")) return "portal";
  if (p.includes("/checkout")) return "checkout";
  if (p.includes("/thank-you")) return "thank-you";
  if (p.includes("/customize")) return "storefront-customize";
  // A storefront product page — /store/{workspace}/{slug} (or a branded-domain rewrite of it).
  if (p.includes("/store/") || p.includes("/products/")) return "storefront-pdp";
  return "storefront";
}

/** The page PATH only — query string + hash stripped (they may carry tokens / PII), length-capped. */
export function sanitizePage(href: string | null | undefined): string {
  const raw = (href || "").toString();
  // Keep only the path: drop scheme/host (if any), then drop ?query and #hash.
  let path = raw;
  const schemeIdx = path.indexOf("://");
  if (schemeIdx >= 0) {
    const afterScheme = path.slice(schemeIdx + 3);
    const slash = afterScheme.indexOf("/");
    path = slash >= 0 ? afterScheme.slice(slash) : "/";
  }
  path = path.split("?")[0].split("#")[0];
  return (path || "/").slice(0, MAX_PAGE);
}

/** Trim a stack to a sane cap so a megabyte of frames can't be posted. */
export function trimStack(stack: string | null | undefined): string | null {
  if (!stack) return null;
  return String(stack).slice(0, MAX_STACK) || null;
}

export interface ClientErrorReport {
  surface: ClientErrorSurface;
  /** the error message (capped server + client side). */
  message: string;
  /** trimmed stack, or null. */
  stack?: string | null;
  /** the page path (no query/hash). Defaults to the current location. */
  page?: string;
}

// Recent (surface|message) signatures → last-sent epoch ms. Bounds client-side spam.
const recentlySent = new Map<string, number>();

function shouldSend(signature: string): boolean {
  const now = Date.now();
  const last = recentlySent.get(signature);
  if (last && now - last < DEDUP_WINDOW_MS) return false;
  recentlySent.set(signature, now);
  // Keep the map small — evict anything outside the window.
  if (recentlySent.size > 100) {
    for (const [k, t] of recentlySent) if (now - t > DEDUP_WINDOW_MS) recentlySent.delete(k);
  }
  return true;
}

/**
 * POST a body to the ingest, fire-and-forget. Uses a text/plain body so it's a
 * CORS-safelisted "simple" request (no preflight) — the Shopify portal posts
 * cross-origin; sendBeacon survives page unload. Never throws.
 */
function postIngest(url: string, body: Record<string, unknown>): void {
  try {
    const json = JSON.stringify(body);
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([json], { type: "text/plain;charset=UTF-8" });
      if (navigator.sendBeacon(url, blob)) return;
    }
    if (typeof fetch === "function") {
      void fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: json,
        keepalive: true,
        mode: "no-cors",
        credentials: "omit",
      }).catch(() => {});
    }
  } catch {
    // Fail-open — a reporter that can crash the path it reports on is worse than the gap.
  }
}

/**
 * Report one client error to the ingest. `origin` is the absolute app origin to
 * post to (empty string = same-origin relative). Best-effort, deduped, never throws.
 */
export function reportClientError(report: ClientErrorReport, origin = ""): void {
  try {
    const message = (report.message || "Unknown client error").toString().slice(0, MAX_MESSAGE);
    const surface = report.surface;
    const page =
      report.page ?? sanitizePage(typeof window !== "undefined" ? window.location?.pathname : "/");
    if (!shouldSend(`${surface}|${message}`)) return;
    postIngest(`${origin}${INGEST_PATH}`, {
      surface,
      page,
      message,
      stack: trimStack(report.stack),
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
    });
  } catch {
    // Fail-open.
  }
}

/**
 * A benign "we're alive" heartbeat — proves the feed is wired + live so the
 * Control Tower panel can go green "connected · 0 errors" instead of amber
 * "awaiting first event", WITHOUT needing a real crash. Throttled to once per
 * browser session (sessionStorage) so storefront traffic can't flood the beats.
 */
export function sendClientErrorHeartbeat(surface: ClientErrorSurface, origin = ""): void {
  try {
    const key = "__cx_client_err_hb";
    if (typeof sessionStorage !== "undefined") {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    }
    postIngest(`${origin}${INGEST_PATH}`, { heartbeat: true, surface });
  } catch {
    // Fail-open.
  }
}

/**
 * Install the global window.onerror + unhandledrejection listeners. `getSurface`
 * is called at error time so a single install can classify by the CURRENT page
 * (the storefront SPA navigates between PDP / customize / checkout / thank-you).
 * Idempotent (guards a window flag); returns a cleanup fn. Never throws.
 */
export function installWindowErrorReporter(
  getSurface: () => ClientErrorSurface,
  origin = "",
): () => void {
  if (typeof window === "undefined") return () => {};
  const w = window as unknown as { __cxClientErrReporter?: boolean };
  if (w.__cxClientErrReporter) return () => {};
  w.__cxClientErrReporter = true;

  const onError = (event: ErrorEvent) => {
    try {
      const err = event.error as Error | undefined;
      reportClientError(
        {
          surface: getSurface(),
          message: err?.message || event.message || "window.onerror",
          stack: err?.stack || null,
        },
        origin,
      );
    } catch {
      /* fail-open */
    }
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    try {
      const reason = event.reason as unknown;
      const message =
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
            ? reason
            : "unhandledrejection";
      reportClientError(
        {
          surface: getSurface(),
          message: `Unhandled rejection: ${message}`,
          stack: reason instanceof Error ? reason.stack : null,
        },
        origin,
      );
    } catch {
      /* fail-open */
    }
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    w.__cxClientErrReporter = false;
  };
}
