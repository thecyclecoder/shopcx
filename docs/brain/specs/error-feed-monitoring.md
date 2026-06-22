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

## Phase 1 — Inngest + Vercel feeds + app-layer DB reporter ⏳
The `inngest/function.failed` handler; the `/api/webhooks/vercel-logs` endpoint (signature-verified, grouped, rate-limited) + I create the Vercel Log Drain; the `reportDbError` app-layer reporter; all three wired into Control Tower alerts + a dashboard "Errors" section (Vercel · Inngest · Supabase-app panels). Brain: [[control-tower]] · new `inngest/inngest-failure-capture` page · new webhook page · [[../operational-rules]] (don't swallow DB errors — call `reportDbError`).

## Phase 2 — Supabase Management Logs API ⏳
Once the owner provides a Supabase access token (stored encrypted): poll/stream Postgres/API/auth error logs into the Control Tower (DB-level errors our app never sees — constraint violations behind RLS, auth failures, slow-query/timeouts). Dashboard "Supabase errors" panel + alerting.

## Verification
- **Inngest:** force an Inngest function to fail (throw past retries) → a Control Tower alert + the failure on the Inngest panel within a cycle; owners paged once (not per-retry).
- **Vercel:** trigger a prod route 500 → the Log Drain delivers to `/api/webhooks/vercel-logs`, a grouped incident + alert appears; a burst of the same error = one incident (rate-limited), a new signature = a new alert.
- **Supabase (app-layer):** a code path that gets a Supabase `{ error }` and calls `reportDbError` → it shows on the Control Tower (the scorecard-class is now visible, not swallowed).
- **Supabase (P2):** with the token set, a DB-level error (e.g. a constraint violation) surfaces on the Supabase panel even when no app code reported it.
- Healthy state → panels green, no alert noise.
