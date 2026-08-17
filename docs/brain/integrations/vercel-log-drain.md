# integrations/vercel-log-drain

**Retired 2026-08-12** — replaced by an in-process Next.js hook. Prod runtime errors reach the Control Tower "Vercel errors" panel via `instrumentation.ts` → `onRequestError` → `recordError` (`source='vercel'`), NOT a Vercel log drain.

**Capture:** `src/instrumentation.ts` (`onRequestError`) · records via [[../libraries/control-tower]] (`error-feed.ts` → `recordError`, `source='vercel'`) · panel: [[../dashboard/control-tower]] · rail: `scripts/_check-no-self-pointing-log-drain.ts` (wired into `predeploy:static`, uses [[../libraries/vercel-drain-redact]] for safe diagnostic printing) · parent spec: [[../specs/replace-log-drain-with-in-process-onrequesterror]].

## The limitation (stated first, plainly)

**Vercel log drains CANNOT filter by log level.** Sampling rules filter by environment + request path prefix + percentage only — per Vercel's own docs, *"if you do not add rules, the drain forwards 100% of data"*. Any design that assumes an error-only drain is built on a capability that does not exist. The retired sink route re-filtered in code after we had already paid for the delivery.

## The incident (2026-08-12)

Measured numbers, from the July 12 – August 11 Vercel bill (not estimated):

| Metric | Value |
|---|---|
| Vercel bill (Jul 12 – Aug 11 2026 subtotal) | **$3,014.48** |
| Edge Requests | 433,580,313 ≈ **167 req/sec** sustained, around the clock |
| Drains Volume | 968.95 GB |
| Function Invocations | 866,361,523 (**exactly 2.00×** edge requests) |
| Fluid CPU | $290.99 |
| Fast Origin Transfer | $239.09 |

**968.95 GB ÷ 433,580,313 requests = 2,400 bytes/request** — the size of a JSON log batch, not a page view. *The edge traffic WAS the drain.*

**Function invocations = 2.00× edge requests** because the sink route used `after()` from `next/server`, so each delivery billed the handler PLUS the continuation (same Lambda invocation, still counted twice on the invocations meter).

Attributable: Edge Requests **$858.82** + Drains **$484.48** + most of Function Invocations **$501.41**, plus Fluid CPU $290.99 and Fast Origin Transfer $239.09 — call it **~$1,850/mo** of the subtotal that this loop directly caused.

## Why it compounded (the self-feeding mechanism)

The drain endpoint was `https://shopcx.ai/api/webhooks/vercel-logs` — the same app it was draining. So every delivery emitted its own lambda logs (`START` / `END` / `REPORT` / any `console.*` from the sink route), and those logs were shipped by the SAME drain right back to the SAME endpoint. One outbound POST → one Lambda invocation → more logs → another outbound POST. The retired route had a `Runtime Timeout`-specific mitigation (`isBareLifecycle` + the `after()` deadline guard), but the general loop was never mitigated because Vercel's drain has no level filter to break it.

## The replacement

`src/instrumentation.ts` exports Next.js 16's `onRequestError` hook. It fires **in-process** on every server error with the real error object + request context, so there is no log parsing, no HTTP round-trip, and no self-feeding path. It reports through the SAME `recordError` chokepoint on the SAME `source: 'vercel'` value, so the Control Tower panel, signature grouping, rate-limited paging, transient auto-resolve, and repair fan-out are unchanged — the transport changed, downstream did not. Every `isTransient*` / `isForeign*` / `isBare*` / `isInngest*` classifier from `error-feed.ts` is reused, so classification does not regress. Wrapped in try/catch so a reporter failure inside a failing request cannot turn one broken request into two.

**Honest narrowing** — the `onRequestError` hook sees errors from OUR code with a request context. Platform-level events with no request context — a hard **Runtime Timeout**, an **OOM kill** — do NOT route through it and stay visible in Vercel's own observability UI. That is a real, accepted narrowing versus the drain, not an oversight.

## The rail — a self-pointing drain cannot be created silently again

`scripts/_check-no-self-pointing-log-drain.ts`, chained into `npm run predeploy:static`:

- Lists team drains via `GET https://api.vercel.com/v1/drains?teamId=...` and pulls project aliases via `GET /v9/projects/{PROJECT_ID}?teamId=...`.
- Fails the build if any drain's `delivery.endpoint` host is `shopcx.ai`, ends in `.shopcx.ai`, or is a `*.vercel.app` alias belonging to project `prj_80PnLIjdKT4YAxITnbjkTCgbP0Qv`.
- Skips (exit 0) when neither `VERCEL_API_TOKEN` nor `VERCEL_TOKEN` is set — a guard that fails closed on a missing credential just teaches everyone to ignore it; the credentialed deploy pipeline enforces the invariant.
- Degrades to skip (exit 0) on a Vercel-API read failure — a transient upstream is not a self-pointing drain.
- Prints the cost arithmetic on failure so whoever trips it sees the stakes immediately.

A **disabled** drain is still a configured drain someone can flip back on — the rail treats disabled and enabled the same. The `_delete-self-pointing-vercel-drain.ts` one-off in `scripts/` removes the retired `drn_kQkATjjmtVrTnRrj` ("SHOPCX Control Tower") drain via the Vercel API, using [[../libraries/vercel-drain-redact]] (`summarizeDrain`) to safely print the operation to CI logs.

## Related

[[../specs/replace-log-drain-with-in-process-onrequesterror]] · [[../libraries/control-tower]] · [[../libraries/vercel-drain-redact]] · [[../tables/error_events]] · [[../inngest/inngest-failure-capture]] · [[../dashboard/control-tower]] · [[../libraries/notify-ops-alert]]
