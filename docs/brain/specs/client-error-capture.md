# Client-Side Error Capture — storefront + portal → Control Tower ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[error-feed-monitoring]] + [[control-tower]]. The missing **fourth error feed** (the Control Tower has Vercel · Inngest · Supabase — all *server-side*).

Vercel logs (our log drain) only capture **server-side** errors — SSR crashes, API 500s, function failures. **Client-side JS that breaks the UX in the user's browser is invisible to us**: a React render crash on the PDP, a broken "customize" interaction, an unhandled promise rejection, a Braintree widget failing on checkout, a thank-you-page script erroring. Today there is **no general client capture** — no global error boundary, no `window.onerror`/`unhandledrejection` handler, no Sentry — *except* a narrow `/api/checkout/log-error` (checkout-only: token/Braintree/validation). So PDP, customize, thank-you, and the **portal** have zero coverage, and **checkout** (where a silent JS break = lost revenue) is only partly covered. This closes that gap.

## Model
- **Capture (storefront + portal):** a global React **error boundary** (`app/global-error.tsx` / per-surface boundaries; an ErrorBoundary in the in-house portal AND the Shopify-extension portal `portal-src/`) + a `window.onerror` + `window.addEventListener('unhandledrejection')` listener. On an error, collect `{ surface (storefront-pdp / storefront-customize / checkout / thank-you / portal), page (path), message, stack (trimmed), userAgent }`.
- **Ingest:** `POST /api/client-errors` (public, no auth — like the checkout one) that **generalizes `/api/checkout/log-error`** (fold checkout into it). Validates + size-caps the payload, then `recordError({ source: 'client', keyParts: [surface, page, normalizedMessage], title, detail, sample })` → rides the existing [[../tables/error_events]] + grouping infra.
- **Surface:** a **"Client errors" panel** in the Control Tower error feed ([[../dashboard/control-tower]]) alongside Vercel/Inngest/Supabase — grouped by surface+page+message, recency-colored, connection-aware ([[error-feed-honest-panels]]: amber "no client errors received yet" until a delivery, green "connected · 0 errors").

## Guardrails (untrusted client input)
- **Rate-limit + dedup** per IP/session and per signature — a flapping client error must not flood `error_events` (one incident per signature, count bumps). Cap payload + stack size.
- **No PII** — capture the error message/stack/page, never form values / tokens / customer data; strip query strings that may carry tokens.
- **Fail-open for the user** — the reporter never blocks rendering; a failed report is silently dropped (the page must not break worse trying to report a break).

## Verification
- Throw a client-side error on the PDP (e.g. a forced render crash behind a test flag) → within the recency window a `client` `error_events` row appears (`surface='storefront-pdp'`, the page + message), and the Control Tower **Client errors** panel shows it.
- An unhandled promise rejection on checkout / a Braintree tokenize failure → captured as `surface='checkout'` (the existing checkout path now flows through the general ingest).
- A portal client crash (in-house + Shopify-extension portal) → captured `surface='portal'`.
- Spam the ingest with the same error 100× → ONE incident (count bumps), not 100 rows; an oversized/garbage payload → rejected, not stored.
- Connection-aware: before any client error arrives, the panel reads amber "awaiting first event," not a false green; the header health count excludes it until connected.
- Negative: a normal page with no client errors → green "connected · 0 errors" once any (even benign) report/heartbeat lands; no PII in any stored row.

## Phase 1 — ingest endpoint + storefront/portal reporters + Client panel ✅
`/api/client-errors` (generalize `/api/checkout/log-error` → `recordError(source:'client')`, rate-limited + PII-stripped); a global error boundary + `window.onerror`/`unhandledrejection` reporter wired into the storefront (PDP/customize/checkout/thank-you) and both portals; the **Client errors** panel in `buildErrorFeedSnapshot` + the dashboard. Brain: [[../libraries/client-error-reporter]] · [[../libraries/control-tower]] · [[../tables/error_events]] · [[../dashboard/control-tower]] · [[error-feed-monitoring]] · [[error-feed-honest-panels]] · [[../lifecycles/storefront-checkout]] · [[../lifecycles/customer-portal]].

**Status (shipped — code complete + migration applied):**
- ✅ `POST /api/client-errors` (`src/app/api/client-errors/route.ts`) — public, text/plain+CORS, size-cap + surface allowlist + per-IP rate limit + PII strip; `recordError(source:'client')` + `recordFeedDelivery('client')`; `{heartbeat:true}` = liveness beat only.
- ✅ Shared reporter `src/lib/client-error-reporter.ts` + `<ClientErrorReporter>` (`src/components/ClientErrorReporter.tsx`, window listeners + React boundary) wired into `(storefront)/layout.tsx` (PDP/customize/checkout/thank-you, classified by live path) + `portal/[slug]/layout.tsx` (in-house portal). Root `src/app/global-error.tsx` boundary.
- ✅ Shopify-extension/mini-site Preact portal: `portal-src/js/core/error-reporter.js` + `components/ErrorBoundary.jsx`, wired in `portal-entry.jsx`; posts cross-origin to absolute `__APP_ORIGIN__` (injected by `build-portal.js` + `build-minisite-portal.js`). **Both bundles rebuilt** via `scripts/build-all-portals.js`.
- ✅ `source='client'` threaded through `error-feed.ts` (`ErrorSource`, `SOURCES`, `REQUIRES_RECEIPT`, configured/received maps, feed query) + the dashboard **Client errors** panel.
- ✅ **Applied:** `supabase/migrations/20260622170000_client_error_source.sql` (widens `error_events.source` CHECK to admit `'client'`) via `scripts/apply-client-error-source-migration.ts`. Redeploy on merge ships the rebuilt portal bundles.

**Decision (surfaced, not guessed):** `/api/checkout/log-error` + the `checkout_errors` per-cart funnel diagnostic are **kept** — "fold checkout into it" is implemented as: `/api/client-errors` is the generalized public ingest, and the checkout surface is now ALSO covered by the general window reporter (uncaught errors / unhandled rejections / Braintree throws → `surface='checkout'`). Fully retiring `checkout_errors` into `error_events` would lose the cart_token/stage/customer funnel telemetry — out of scope for Phase 1; revisit if the owner wants it.

## Verification
- On the PDP, force a client-island render crash (e.g. a test-flagged `throw` in a hydrated island) → within the 7-day window an `error_events` row appears with `source='client'`, `surface='storefront-pdp'`, the page path + message, and the Control Tower **Client errors** panel shows it (red ≤1 h). *(Requires the migration applied.)*
- On checkout, trigger an unhandled promise rejection / a Braintree tokenize throw → captured as `source='client'`, `surface='checkout'` via the window reporter (the per-cart `checkout_errors` diagnostic is unaffected and still logs its own `logBlock` entries).
- In the in-house portal (`/portal/{slug}`) AND the Shopify-extension portal, force a render crash → captured `source='client'`, `surface='portal'`; the Preact bundle posts cross-origin to `https://shopcx.ai/api/client-errors` (verify `subscription-portal.js` in `extensions/.../assets/` + `public/portal-assets/` contains `shopcx.ai` + `/api/client-errors`).
- `curl -X POST https://shopcx.ai/api/client-errors` 100× with the SAME `{surface,page,message}` → **one** `error_events` incident (`count` ≈ 100), not 100 rows. A `>16KB` or non-JSON body → HTTP 200 `{ok:false}`, nothing stored. >30 distinct messages/min from one IP → throttled (`{ok:false,throttled:true}`).
- Before any client error/heartbeat arrives, the **Client errors** panel reads amber "awaiting first event"; the header health count excludes it (not a false green). After one storefront/portal load (per-session heartbeat) with no errors → green "connected · 0 errors".
- Inspect any stored `client` row's `detail`/`sample` → the page is a **path only** (no `?query`/`#hash`), no form values / tokens / customer data; `userAgent` present, message/stack capped.
