# inngest/media-buyer-all-customers-refresh

Weekly Mon 12:00 UTC cron: incremental top-up of each per-test cohort's CUSTOMER_LIST (all-customers, hashed) exclusion audience. Uploads customers whose `first_order_at >= watermark` (last-run completion or now − 8d on first run) — hashed email + phone only, no plaintext PII. Keeps the cold-test rail's complete existing-customer coverage current so newly-acquired customers stop seeing cold-prospecting adsets as the business grows. [[../specs/bianca-full-order-history-customer-list-exclusion-audience]] Fix 1.

**File:** `src/lib/inngest/media-buyer-all-customers-refresh.ts`

## Functions

### `media-buyer-all-customers-refresh-weekly`
- **Trigger:** cron `0 12 * * 1` (Mondays 12:00 UTC)
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1 }]`
- **Owner:** Growth (Bianca) — declared in [[../libraries/control-tower]] `MONITORED_LOOPS`
- **Liveness window:** 9 days (weekly + 20% jitter grace per the monitor-cadence invariant)

## Pure helpers

- `pickRefreshWatermarkIso({ lastRunAtIso, nowIso, lookbackDays? })` — returns the ISO the customers-since-watermark selector reads. On first run (no last-run row) falls back to `now − 8d` — one 24h grace over the 7d cadence so a paused/delayed run doesn't silently skip the miss window. Unit-tested in `src/lib/media-buyer/all-customers-exclusion.test.ts`.

## Downstream events sent

_None._

## Tables written

- [[../tables/media_buyer_all_customers_refresh_runs]] — one row per successful refresh, carrying the watermark the next run reads.
- `loop_heartbeats` — via `emitCronHeartbeat` at end of run (Control Tower node-completeness trio).

## Tables read (not written)

- [[../tables/media_buyer_test_cohorts]] — enumerates active per-test cohorts whose `excluded_all_customers_audience_id` is non-null.
- [[../tables/customers]] — filters by `workspace_id` + `first_order_at >= watermark` for the incremental upload.
- [[../tables/meta_connections]] / [[../tables/workspaces]] — via `getMetaUserToken` for the per-workspace ads_management token.

## External calls

- Meta Graph `POST /{audience_id}/users` via [[../libraries/meta-ads]] `addUsersToCustomAudience` — chunked at ≤ 10,000 rows per POST, `schema=['EMAIL_SHA256','PHONE_SHA256']`. Plaintext PII never leaves the box.

## Node-completeness trio (CLAUDE.md hard rule)

- **Owner** — `owner: 'growth'` on the `MONITORED_LOOPS` row (registered in [[../libraries/control-tower]]); [[../libraries/control-tower-node-registry]] resolves it to the Growth department seat with no orphan fallthrough.
- **Kill switch ancestry** — inherits Growth's `director:growth` seat (Bianca) via the node-registry's parent chain, so pausing Growth pauses this cron.
- **Heartbeat** — `emitCronHeartbeat("media-buyer-all-customers-refresh-weekly", { ok, produced, detail })` at end of run; monitored by `control-tower-monitor` against `livenessWindowMs = 9d`.

---

[[../README]] · [[../integrations/inngest]] · [[../libraries/meta-ads]] · [[../libraries/control-tower]] · [[../../CLAUDE]]
