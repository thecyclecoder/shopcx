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
- **Dispatch is currently daily-guarded:** the fired sweep still carries `dispatchMediaBuyerCadence`'s once-per-UTC-day guard, so Bianca acts at most daily on the fresh data today. The **2h dispatch** (relaxing that guard for test cohorts) is the follow-up that makes the review truly intraday.
- **A product with test ads but NO active cohort is invisible here** (e.g. Amazing Coffee before it's given a cohort) — the pull only covers cohorts. Every product with test ads must have a cohort.

## Related

[[meta-performance]] · [[../libraries/meta-performance]] (`syncMetaStructure` / `syncMetaInsightsForLevel` scoping) · [[media-buyer-cadence]] · [[../libraries/media-buyer-agent]] · [[../tables/media_buyer_test_cohorts]] · [[../reference/meta-scaling-methodology]]
