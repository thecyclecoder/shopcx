# inngest/media-buyer-test-cadence

The **crisp intraday freshness loop** for media-buyer TEST campaigns (CEO Dylan, 2026-07-12). Source: `src/lib/inngest/media-buyer-test-cadence.ts`.

## Why

The daily full-account pipeline ([[meta-performance]] `metaPerformanceDailyCron`, 11:30 UTC) rolls up the **previous day** for every account. But a test ad spends ~$150/day (~$6/hr), so by late-day it can carry ~$100 of **today's** spend the DB hasn't seen — a stale scorecard hides a dud that already crossed its $300 kill line or a winner that crossed $450. This cron closes that gap: **every 2 hours**, pull insights for ONLY the media-buyer **test campaigns** (not the whole account), including today, and refresh their scorecards so Bianca reviews fresh data.

**2h, not 1h:** at ~$6/hr a 2h window is ~$12.50 of new spend — enough to matter, frequent enough to crown within 2h of $450 and catch a dud near $300, without over-sampling attribution-incomplete data. The decision stays **threshold-gated** (most cycles are no-ops). Full-account / previous-day stays on the daily cron.

## Functions

### `media-buyer-test-cadence` (cron `0 */2 * * *` + event `growth/media-buyer-test-cadence`)
1. `resolveTestCadenceTargets` — every ACTIVE [[../tables/media_buyer_test_cohorts]] row → grouped by `(workspace, account)` with the set of test campaign ids. Per-test cohorts contribute `test_meta_campaign_id`; legacy shared-adset cohorts contribute their adset's parent campaign (resolved from `meta_adsets.meta_campaign_id`). A cohort missing its account or a resolvable campaign is skipped.
2. Per account: `getMetaUserToken` → [[../libraries/meta-ads]]-adjacent [[../libraries/meta-performance]] `syncMetaStructure({campaignIds})` + `syncMetaInsightsForLevel` (adset + ad, window = today + 2 back for late attribution, `{campaignIds}`) → `refreshScorecards`. All three sync calls are **campaign-scoped** via Graph `filtering=[{field:"campaign.id",operator:"IN",value:[...]}]` — the account's non-test campaigns are never pulled.
3. Fires `growth/media-buyer-cadence-sweep` → Bianca's deterministic review ([[media-buyer-cadence]]) on the fresh data.

## Scoping — the campaign filter

`syncMetaStructure(p, {campaignIds})` and `syncMetaInsightsForLevel(p, level, since, until, {campaignIds})` gained an optional `campaignIds` that injects Graph `filtering` (campaigns edge filters by `id`; adsets/ads/insights by `campaign.id`). Omitting it preserves the full-account behavior the daily cron relies on.

## Gotchas

- **Timezone normalization (accounts differ — LA vs Chicago):** Meta buckets insights by the **account's** timezone (the stored `snapshot_date` = Graph `date_start`), so the data is already per-account-correct. The pull **window** is account-local (`localDayInTz` via the account's `meta_ad_accounts.timezone`) so each account's current ad-day is always included even after UTC rolls over (e.g. 8:38pm Mountain = still 07-12 in LA/Chicago while UTC is 07-13). The scorecard **label** stays UTC-today to match the media-buyer loop's snapshot read (`agent.ts` reads `snapshot_date` = UTC-today); the trailing 7d rollup folds the account-local day in. Strict account-local scorecard labels would need the loop to read account-local too — a follow-up.
- **Idempotent:** insights upsert on `(workspace_id, meta_object_id, level, snapshot_date)`; structure on the object id. Re-running a 2h slot never double-counts.
- **Dispatch is 2h-capable, NOT daily-guarded (verified 2026-07-12):** the fired sweep runs `dispatchMediaBuyerCadence`, whose guard is a *concurrency* guard — it skips a workspace-account pair only while an UNFINISHED (`ACTIVE_MEDIA_BUYER_JOB_STATUSES`) `kind='media-buyer'` job from today is still in flight. A **completed** job does NOT block (asserted in [[media-buyer-cadence]] `.test.ts` — "a COMPLETED job from earlier today does NOT block a fresh dispatch"). Since a media-buyer job completes in minutes, the next 2h sweep re-dispatches a fresh review. So the 2h intraday review is **already live** as of this cron — no guard needs relaxing. (The only thing that blocks re-dispatch is a job stuck non-terminal, e.g. `needs_approval` awaiting a CEO decision — correct: don't stack reviews while one awaits a call.)
- **The review is DETERMINISTIC — no Claude/box session, no LLM tokens:** the box worker runs `kind='media-buyer'` on a **Deterministic-Node lane** (`scripts/builder-worker.ts` `runMediaBuyerJob` → `import runMediaBuyerLoopForAccount`), not a `claude -p` session. The decision is the pure `computeMediaBuyerPlan` ([[../libraries/media-buyer-agent]]); templated `rationale` strings surface the reasoning without an LLM. The SDK is three layers: **pull** ([[../libraries/meta-performance]] `syncMetaInsightsForLevel` + `meta/scorecards` `refreshScorecards`, done by this cron) → **decide** ([[../libraries/media-buyer-agent]] `runMediaBuyerLoopForAccount`/`computeMediaBuyerPlan`, pure) → **execute** (`iteration_actions` ledger applied by the Phase-6a executor / `ad_publish_jobs`).
- **A product with test ads but NO active cohort is invisible here** (e.g. Amazing Coffee before it's given a cohort) — the pull only covers cohorts. Every product with test ads must have a cohort.

## Related

[[meta-performance]] · [[../libraries/meta-performance]] (`syncMetaStructure` / `syncMetaInsightsForLevel` scoping) · [[media-buyer-cadence]] · [[../libraries/media-buyer-agent]] · [[../tables/media_buyer_test_cohorts]] · [[../reference/meta-scaling-methodology]]
