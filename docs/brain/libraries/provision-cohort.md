# `src/lib/media-buyer/provision-cohort.ts`

Stands up a product's **per-test-adset** testing cohort — the "make the campaign + template" half of launching a product's ad tests. The media buyer ([[media-buyer-agent]] Bianca) then mints a fresh **$150 ad set per test creative** in that campaign and runs the [[../reference/meta-scaling-methodology|decision tree]] on it.

## Why

The researched model (deep-research 2026-07-12, [[../reference/meta-scaling-methodology]]): **ABO, one creative per dedicated-budget ad set**, each at ~$150/day so the full budget tests that one creative; `daily_test_ceiling_cents ÷ per_test_daily_budget_cents` = max concurrent tests (4 at $600/$150). The old cohort model published N ads into ONE shared ad set (commingled budgets). This library provisions the new shape.

Bianca's replenish loop does **not** create ad accounts, campaigns, or ad sets — it consumes a cohort. Cohort rows were hand-made in the DB ([[../tables/media_buyer_test_cohorts]]; `cohorts/route.ts` is GET-only). This is the code path that creates them.

## Exports

| Symbol | What |
|---|---|
| `provisionProductTestCohort(admin, opts)` | Idempotent on `(workspace, account, product)`: find-or-creates the account's ABO testing campaign ([[../libraries/meta-ads]] `getOrCreateTestingCampaign`, lands PAUSED) and upserts a `media_buyer_test_cohorts` row with `adset_per_test=true` + the cloned `adset_template`. Calls `assertCohortReplenishable` on the row-being-inserted before the insert so an activated per-test cohort can never persist with a null template. **Creates no ad sets, spends nothing.** Returns `{cohortId, testMetaCampaignId, maxConcurrent}`. |
| `maxConcurrentTests(cohort)` | PURE — `floor(daily_test_ceiling_cents ÷ per_test_daily_budget_cents)`, ≥1. The number of concurrent $150 test ad sets the cohort funds. |
| `buildAdsetTemplate({pixelId, targeting?})` | PURE — the ABO purchase-optimized spec every per-test ad set clones (only the CREATIVE varies across a cohort). |
| `isCohortReplenishable(cohort)` | PURE — true when `adset_per_test=false` (legacy shared adset, no template needed) OR both `test_meta_campaign_id` is non-null AND `adset_template.pixelId` is a non-empty string. The single source of truth both provisioning and Bianca's replenish check should share so the two can never disagree about what "replenishable" means. |
| `assertCohortReplenishable(cohort)` | Throws `cohort_not_replenishable: adset_per_test cohort missing …` when `isCohortReplenishable` would be false. Wired into `provisionProductTestCohort` as an insert-time invariant. |
| `DEFAULT_TEST_TARGETING` | The proven cold-test audience (US 18–65, home+recent, Advantage+ Audience on), cloned from Amazing Coffee's live MB test ad sets. |

## Model / invariants

- **Gated OFF by default.** `media_buyer_test_cohorts.adset_per_test` defaults `false` — the legacy single-shared-adset behavior is unchanged for existing cohorts (Superfood Tabs, Amazing Coffee). Only a provisioned cohort opts in.
- **Same audience across a cohort** — `adset_template.targeting` is cloned onto every per-test ad set so the CREATIVE is the only variable (textbook creative isolation).
- **No spend at provision time** — the campaign is PAUSED and no ad sets exist yet; the per-test ad sets are minted (ACTIVE, $150/day) by the replenish/publish path when Bianca fills a test slot.
- **An active per-test cohort MUST be replenishable.** `assertCohortReplenishable` is called before `provisionProductTestCohort` inserts, so a per-test cohort can never be activated without a `test_meta_campaign_id` + `adset_template` with a non-empty `pixelId`. This is the durable fix behind the 2026-07-14 Superfood Tabs stall (a legacy row slipped through with `adset_template=NULL` and Bianca sat under target for days). Bianca's replenish path shares this predicate in Phase 3 so the "missing config" branch and provisioning agree on what "replenishable" means.
- Inputs it needs (provisioning is a curated step): the account's `meta_ad_accounts.id` UUID + Meta act id, the Facebook `pageId`, and the `pixelId` to optimize against.

## One-time backfill (2026-07-14)

Superfood Tabs' active per-test cohort was created with `adset_template = NULL` (a legacy row that predates `provisionProductTestCohort`), so every Bianca replenish pass hit `media_buyer_replenish_missing_config` and Tabs froze at 2/4 test ads. `scripts/_backfill-cohort-adset-template.ts` rebuilds the template on any active `adset_per_test=true` cohort whose `adset_template` is null or missing `pixelId`, by cloning the pixel from a SIBLING active cohort on the same `meta_ad_account_id` (accounts share a pixel) and running `buildAdsetTemplate({pixelId})` — exactly what `provisionProductTestCohort` (`provision-cohort.ts:92,102`) would have written. It never invents a pixel; a row with no sibling is skipped + logged. Dry-run by default; `APPLY=1 npx tsx scripts/_backfill-cohort-adset-template.ts` writes. Idempotent — a row with a valid template is skipped by the read filter. Phase 2 adds the durable `assertCohortReplenishable` guard so a null template can't reappear on a per-test cohort at provision time.

## Related

[[media-buyer-agent]] · [[meta-ads]] (`getOrCreateTestingCampaign` / `createAdSet`) · [[../tables/media_buyer_test_cohorts]] · [[../reference/meta-scaling-methodology]] · [[../reference/meta-scaling-methodology#the-decision-tree]]
