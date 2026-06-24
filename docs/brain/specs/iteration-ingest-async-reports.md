# Iteration Ingest — Async Insights Reports for Huge Backfills ⏳

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

## Phase 1 — async report path behind a flag ⏳ (deferred — build on demand)
The async-report submit/poll/page path for the backfill window, flag-gated per account; synchronous incremental unchanged. Brain: [[../libraries/meta-performance]] · [[../integrations/meta]].
