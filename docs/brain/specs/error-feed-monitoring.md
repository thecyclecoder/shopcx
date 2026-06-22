# Error-Feed Monitoring — Vercel + Inngest + Supabase into the Control Tower ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[control-tower]]. · **Blocked-by:** [[control-tower]] (plugs into its alert store + dashboard).

The three "hidden surfaces" where failures happen that the dashboard never shows: **Vercel runtime errors** (a route 500ing in prod), **Inngest errored runs** (a function failing after retries), and **Supabase errors** (Postgres/API/auth). Pipe all three into the [[control-tower]] so they page the owner + show on the Control Tower dashboard — instead of being discovered by a customer report or a lucky log dig.

## Feeds
### 1) Inngest errored runs — native event (no setup)
Register a function on **`inngest/function.failed`** (Inngest fires it when a function exhausts retries). It records the failure (`function_id, run_id, error, event, failed_at`) into the Control Tower alert store + a `inngest_failures` panel, and pages owners on a new/spiking failure. Real-time, no polling. (Optional: also expose a Control Tower count "Inngest failures last hour: N".)

### 2) Vercel runtime errors — Log Drain → webhook (I set up the drain)
Create a **Vercel Log Drain** (JSON, `delivery: batch`, filtered to **error/500-level** runtime logs) pointed at a new **`/api/webhooks/vercel-logs`** endpoint (verifies the drain's `x-vercel-signature` against a generated secret). The endpoint **groups by error signature**, **rate-limits** (a burst of the same error = one incident, not 500 pages), and records + alerts on a **new signature or a spike** → Control Tower "Vercel errors" panel. **Setup is mine:** I create the drain via the Vercel API with our token once the endpoint ships; the build writes the endpoint + grouping/alerting. *(Verified: our token has log-drains scope.)*

### 3) Supabase errors — Management Logs API (needs an owner token) + app-layer reporter
Two layers:
- **App-layer DB-error reporter (no token, ships in P1-with-Inngest/Vercel-ideally):** a tiny `reportDbError(error, context)` the code calls (and/or a thin wrapper around `createAdminClient` mutating paths) that pushes any non-null Supabase `{ error }` to the Control Tower. This directly catches the **swallowed-error class** (the scorecard upsert that reported success while erroring) at the source — no external creds.
- **Supabase Management Logs API (P2, needs an owner token):** poll/stream Postgres + API + auth **error**-severity logs via the Supabase **Management/Logs API** — which needs a **Supabase access token (personal/management)** the owner generates (the service-role key we have is for data, not logs). This is the **only** part of this spec requiring owner setup; until the token exists, the app-layer reporter covers the errors our own code sees.

## Setup ownership (answering "what do I set up?")
- **Inngest:** nothing — native event, build adds the handler.
- **Vercel:** nothing — I create the Log Drain via our token after the endpoint ships.
- **Supabase:** the app-layer reporter needs nothing; the **Management Logs API needs you to generate a Supabase access token** (one paste, like the Vercel token) — that's the lone owner action, and it's deferred to P2.

## Phase 1 — Inngest + Vercel feeds + app-layer DB reporter ✅
Shipped. The `inngest/function.failed` handler ([[../inngest/inngest-failure-capture]], registered in `src/app/api/inngest/route.ts`); the `/api/webhooks/vercel-logs` endpoint (HMAC-SHA1 signature-verified, batch-grouped, rate-limited — [[../integrations/vercel-log-drain]]); the `reportDbError` + `recordError` app-layer reporter (`src/lib/control-tower/error-feed.ts`, [[../libraries/control-tower]]) wired into the swallowed scorecard-upsert class (`src/lib/meta/scorecards.ts`); all three grouped into the new [[../tables/error_events]] store (migration `20260622150000_error_events.sql`), paging owners on a new-signature/spike (rate-limited, [[../libraries/notify-ops-alert]]) + a dashboard **Errors** section (Vercel · Inngest · Supabase-app panels) on [[../dashboard/control-tower]]. Brain: [[../tables/error_events]] · [[../inngest/inngest-failure-capture]] · [[../integrations/vercel-log-drain]] · [[../libraries/control-tower]] · [[../dashboard/control-tower]] · [[../operational-rules]] (don't swallow DB errors — call `reportDbError`).

**Owner setup remaining (one-time, not a build step):** (1) generate a `VERCEL_LOG_DRAIN_SECRET` + create the Vercel Log Drain via our token pointed at `/api/webhooks/vercel-logs` (until set, the endpoint is live but returns `503`); (2) set the secret in the Vercel env. The Inngest + Supabase-app feeds need nothing.

## Phase 2 — Supabase Management Logs API ⏳
Once the owner provides a Supabase access token (stored encrypted): poll/stream Postgres/API/auth error logs into the Control Tower (DB-level errors our app never sees — constraint violations behind RLS, auth failures, slow-query/timeouts). Dashboard "Supabase errors" panel + alerting.

## Verification

### Phase 1 (shipped ✅)
- **Migration:** after applying `20260622150000_error_events.sql`, on the DB expect `public.error_events` to exist with the `(source, signature)` unique index and RLS on (authenticated select + service-role all). `scripts/apply-error-events-migration.ts` prints `error_events table present: 1/1`.
- **Inngest:** force a registered Inngest function to throw past its retries → Inngest fires `inngest/function.failed` → on `/dashboard/developer/control-tower` the **Inngest failures** panel shows a `×1` incident titled `<function_id>: <message>` within a poll, and the owners get **one** Slack DM "Control Tower: Inngest failure 🔴" (not one per retry — it fires only after the final retry). Re-fail the same function within 30 min → the incident `count` bumps, **no** second DM (rate-limited).
- **Vercel:** with `VERCEL_LOG_DRAIN_SECRET` set and the drain wired, trigger a prod route 500 → `POST /api/webhooks/vercel-logs` (valid `x-vercel-signature`) returns `{ received, incidents }`, the **Vercel errors** panel shows the grouped incident, and a new signature pages once. Send a batch of N identical 500s → **one** incident with `count += N` (grouped client-side + by signature), one page. A `POST` with a bad signature → `401`; with no secret configured → `503`.
- **Supabase (app-layer):** drive `refreshScorecards` into a persist error (e.g. a constraint violation on `iteration_scorecards_daily`) → `reportDbError` fires → the **Supabase errors (app-layer)** panel shows a `scorecard-upsert (iteration_scorecards_daily): …` incident + a page. (The swallowed-upsert class is now visible at the source, not silently reported as success.)
- **Healthy state:** with no recent errors, all three panels are **green** ("No errors in the last 7 days") — no alert noise. A panel goes red only with an error in the last hour (amber within 24 h).

### Phase 2 (planned ⏳ — needs an owner Supabase access token)
- With the token stored encrypted, a **DB-level** error our app never saw (e.g. a constraint violation behind RLS, an auth failure, a slow-query/timeout) surfaces on a Supabase panel via the Management/Logs API poll — even when no app code reported it.
