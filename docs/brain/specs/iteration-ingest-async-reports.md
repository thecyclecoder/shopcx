# Iteration Ingest — Async Insights Reports for Huge Backfills 🚧

**Priority:** critical

**Owner:** [[../functions/growth]] · **Parent:** Growth mandate "Storefront CRO" — follow-on to [[iteration-engine-ingest-resilience]] (the originally-deferred Phase 3, split out so the parent ships).
**Deferred:** future optimization, build only if needed (P1/P2 of the parent already solve transient errors + large ranges). CEO-deferred 2026-06-24 — every auto-build lane skips it until promoted back to Planned.

**Build only if needed** — this is a future optimization, not a fix. [[iteration-engine-ingest-resilience]]'s P1 (retry/backoff) + P2 (≤14-day chunked, resumable backfill) already solve transient errors *and* large date ranges. This phase exists for the edge where even chunked sync GETs strain — a brand-new account backfilling *years* of insights — where Meta's sanctioned **async report** path is the right tool.

## When to build this
- A first-run backfill that's so large the chunked sync path is slow/flaky despite ≤14-day slices (very long ranges × 3 levels), or Meta starts rate-limiting the chunked GET volume. Until that's observed, P2's chunking is sufficient — **leave this deferred.**

## What it would do
- For the **first-run backfill window only**, submit an **async insights report** (`POST /act_{id}/insights` → `report_run_id`; poll `GET /{report_run_id}` until `job_status='Job Completed'`; then page the results) instead of synchronous GET.
- Keep the **synchronous GET** for the small daily incremental window (async overhead isn't worth it for 3 days).
- **Gate behind a flag**, per-account, so it ships independently and can be enabled only where the large-backfill pain is real.

## Verification
- Enable the flag for an account with an empty `meta_insights_daily` and a long backfill range → ingest submits an async report, polls to completion, pages results, and lands rows across all three levels with no `Service temporarily unavailable`; the daily incremental run still uses the light synchronous path.
- Idempotency + the existing failure/alerting behavior from [[iteration-engine-ingest-resilience]] are unchanged.

## Phase 1 — async report path behind a flag 🚧 (built — pending migration apply + verification)
The async-report submit/poll/page path for the backfill window, flag-gated per account; synchronous incremental unchanged. Brain: [[../libraries/meta__performance]].

**Built 2026-06-24** (promoted from deferred → critical by director directive):
- `src/lib/meta/performance.ts` — extracted `mapInsightsRecords` (shared row→record mapping for sync + async), added `graphPost`, `submitInsightsReport`, `pollInsightsReport`, `syncMetaInsightsForLevelAsync`, `syncMetaInsightsAsync`, and the per-account flag reader `isAsyncBackfillEnabled` (defensive — missing column ⇒ disabled). `ingestMetaPerformance` now routes the **first-run backfill window only** through the async path when `backfilled && isAsyncBackfillEnabled(...)`; daily incremental is untouched. Returns `asyncBackfill` for observability.
  - Submit `POST /act_{id}/insights` → `report_run_id`; poll `GET /{report_run_id}` until `async_status='Job Completed'` (tolerates `job_status`; throws on `Job Failed`/`Job Skipped`/10-min timeout); page `GET /{report_run_id}/insights`. Output → same `mapInsightsRecords` + `upsertOrThrow`, so idempotency + the rows-written assertion are unchanged.
- `src/lib/inngest/meta-performance.ts` — the iteration-run `ingest` stage now records `async_backfill`.
- Migration `supabase/migrations/20260706170000_meta_async_insights_backfill_flag.sql` + `scripts/apply-meta-async-insights-backfill-flag-migration.ts` — adds `meta_ad_accounts.async_insights_backfill_enabled boolean NOT NULL DEFAULT false`.

**Remaining to ship:** (1) apply the migration to prod (needs approval — worker has no prod creds); (2) flip the flag on for the target large-backfill account and run the Verification steps above.
