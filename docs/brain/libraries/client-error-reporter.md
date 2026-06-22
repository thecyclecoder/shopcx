# libraries/client-error-reporter

The browser-side half of the **fourth error feed** ([[../specs/client-error-capture]]). Vercel's log drain only sees **server-side** errors (SSR crashes, API 500s); client-side JS that breaks the UX in the user's browser — a React render crash on the PDP, a broken "customize" interaction, an unhandled promise rejection / Braintree failure on checkout, a portal crash — is invisible to it. These reporters capture those and POST them to the public `/api/client-errors` ingest, which folds them into [[../tables/error_events]] under `source='client'` ([[control-tower]] `error-feed.ts`) → the Control Tower **"Client errors"** panel ([[../dashboard/control-tower]]).

**Files:** `src/lib/client-error-reporter.ts` (pure helpers — shared by the Next storefront + in-house portal) · `src/components/ClientErrorReporter.tsx` (`'use client'` React boundary + window listeners) · `src/app/global-error.tsx` (root boundary) · `src/app/api/client-errors/route.ts` (the public ingest) · `shopify-extension/portal-src/js/core/error-reporter.js` + `components/ErrorBoundary.jsx` (the Preact portal's own copy).

## Two hard rules (untrusted, in the user's browser)

- **FAIL-OPEN** — a reporter NEVER blocks rendering and NEVER throws; a failed report is silently dropped. The page must not break worse trying to report a break.
- **NO PII** — capture the error message/stack and the page **path** only. Query strings (may carry tokens) + hash are stripped; form values / tokens / customer data are never read.

## `src/lib/client-error-reporter.ts` (pure helpers)

- `type ClientErrorSurface = "storefront-pdp" | "storefront-customize" | "checkout" | "thank-you" | "portal" | "storefront"` — the capture surface, part of the `error_events` grouping key.
- `classifySurface(pathname)` — maps a path → surface (portal wins, then checkout / thank-you / customize, then `/store/` or `/products/` → PDP, else generic storefront). Called **at error time** so one install classifies by the live path as the storefront SPA navigates.
- `sanitizePage(href)` — path only (scheme/host/`?query`/`#hash` stripped), capped 300.
- `trimStack(stack)` — capped 4000.
- `reportClientError({ surface, message, stack?, page? }, origin?)` — client-side dedup (same `surface|message` within 30 s dropped) → `postIngest`. `origin` is the absolute app origin ("" = same-origin relative).
- `sendClientErrorHeartbeat(surface, origin?)` — a benign "we're alive" beat, throttled to **once per browser session** (`sessionStorage`), so the panel can read green "connected" instead of amber "awaiting first event" without a real crash.
- `installWindowErrorReporter(getSurface, origin?)` → cleanup fn — idempotent (window flag) `window.addEventListener('error' | 'unhandledrejection')`; `getSurface()` is called at error time.
- `postIngest` uses a **`text/plain` `sendBeacon`** (CORS-safelisted "simple" request — no preflight; survives page unload), falling back to `fetch` `keepalive` + `mode:'no-cors'`.

## `src/components/ClientErrorReporter.tsx` (`'use client'`)

`<ClientErrorReporter>{children}</ClientErrorReporter>` — two captures in one mount: a **React error boundary** around children (catches a client-island render crash via `componentDidCatch` → `reportClientError`; re-renders children so it doesn't blank the tree — Next's own `error.tsx` owns the user-facing fallback), and a `useEffect` that installs the window listeners + sends the heartbeat. Surface from `usePathname`/live `window.location.pathname`. **Mounted in** `src/app/(storefront)/layout.tsx` (covers PDP / customize / checkout / thank-you from one mount) and `src/app/portal/[slug]/layout.tsx` (surface `portal`). Both same-origin → `origin=""`.

`src/app/global-error.tsx` — Next's root boundary; reports a root-layout crash before showing a minimal fallback (covers the root itself, which is above `<ClientErrorReporter>`).

## `src/app/api/client-errors/route.ts` (public ingest)

`POST` — **public, no auth** (like `/api/checkout/log-error`, which it generalizes). Reads a `text/plain` body → JSON. **Guards**: 16 KB body cap; surface allowlist; message/stack/page caps; a coarse **per-IP rate limit** (≤30 distinct incidents / 60 s, in-memory/per-instance — `recordError` already collapses a same-signature burst to one row + count bump); garbage/oversized → **200 `{ok:false}`** (rejected, not stored — never 500 a client's error report). On a valid error → `recordError({ source:'client', keyParts:[surface, page, message], title, detail, sample })` + `recordFeedDelivery('client')`. A `{heartbeat:true}` body → `recordFeedDelivery('client')` only (no incident). `OPTIONS` + permissive CORS for the cross-origin Shopify portal.

## Shopify-extension portal (Preact, separate bundle)

`portal-src/js/core/error-reporter.js` — a dependency-free copy of the helpers (`installPortalErrorReporter()` + `reportPortalCrash(error)`), wired in `portal-entry.jsx` (install before bootstrap; `<App>` wrapped in `components/ErrorBoundary.jsx`). It runs **cross-origin** from the app (Shopify storefront / branded mini-site domains), so it POSTs to the **absolute** `__APP_ORIGIN__/api/client-errors` (injected at build time from `shopify.app.toml` `[app_proxy].url` origin → `https://shopcx.ai`, by both `build-portal.js` and `scripts/build-minisite-portal.js`). **Rebuild both bundles** after editing `portal-src/`: `node scripts/build-all-portals.js`.

## Gotchas

- **Heartbeat is once-per-session** to keep storefront traffic from flooding [[../tables/loop_heartbeats]] — the panel only needs one beat to go green. Both the Next + Preact reporters share the `__cx_client_err_hb` sessionStorage key.
- **The error boundary re-renders children** (doesn't latch a fallback) — a deterministic render crash reports once, then bubbles to Next's nearest `error.tsx`/`global-error` for the real fallback; the duplicate report is swallowed by the 30 s client-side dedup.
- **`/api/checkout/log-error` stays** — it's the per-cart funnel diagnostic into [[../tables/checkout_errors]] (cart_token / stage / customer), a different concern from this cross-surface health feed. Checkout is now ALSO covered here via the window reporter (surface `checkout`).

## Related

[[../specs/client-error-capture]] · [[control-tower]] (`error-feed.ts` — `recordError`/`recordFeedDelivery`) · [[../tables/error_events]] · [[../dashboard/control-tower]] · [[../specs/error-feed-monitoring]] · [[../specs/error-feed-honest-panels]] · [[../lifecycles/storefront-checkout]] · [[../lifecycles/customer-portal]] · [[../tables/checkout_errors]]
