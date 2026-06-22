# Client-Side Error Capture — storefront + portal → Control Tower ⏳

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

## Phase 1 — ingest endpoint + storefront/portal reporters + Client panel ⏳
`/api/client-errors` (generalize `/api/checkout/log-error` → `recordError(source:'client')`, rate-limited + PII-stripped); a global error boundary + `window.onerror`/`unhandledrejection` reporter wired into the storefront (PDP/customize/checkout/thank-you) and both portals; the **Client errors** panel in `buildErrorFeedSnapshot` + the dashboard. Brain: [[../libraries/control-tower]] · [[../tables/error_events]] · [[../dashboard/control-tower]] · [[error-feed-monitoring]] · [[error-feed-honest-panels]] · [[../lifecycles/storefront-checkout]] · [[../lifecycles/customer-portal]].
