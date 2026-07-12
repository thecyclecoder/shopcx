# `src/lib/media-buyer/provision-cohort.ts`

Stands up a product's **per-test-adset** testing cohort — the "make the campaign + template" half of launching a product's ad tests. The media buyer ([[media-buyer-agent]] Bianca) then mints a fresh **$150 ad set per test creative** in that campaign and runs the [[../reference/meta-scaling-methodology|decision tree]] on it.

## Why

The researched model (deep-research 2026-07-12, [[../reference/meta-scaling-methodology]]): **ABO, one creative per dedicated-budget ad set**, each at ~$150/day so the full budget tests that one creative; `daily_test_ceiling_cents ÷ per_test_daily_budget_cents` = max concurrent tests (4 at $600/$150). The old cohort model published N ads into ONE shared ad set (commingled budgets). This library provisions the new shape.

Bianca's replenish loop does **not** create ad accounts, campaigns, or ad sets — it consumes a cohort. Cohort rows were hand-made in the DB ([[../tables/media_buyer_test_cohorts]]; `cohorts/route.ts` is GET-only). This is the code path that creates them.

## Exports

| Symbol | What |
|---|---|
| `provisionProductTestCohort(admin, opts)` | Idempotent on `(workspace, account, product)`: find-or-creates the account's ABO testing campaign ([[../libraries/meta-ads]] `getOrCreateTestingCampaign`, lands PAUSED) and upserts a `media_buyer_test_cohorts` row with `adset_per_test=true` + the cloned `adset_template`. **Creates no ad sets, spends nothing.** Returns `{cohortId, testMetaCampaignId, maxConcurrent}`. |
| `maxConcurrentTests(cohort)` | PURE — `floor(daily_test_ceiling_cents ÷ per_test_daily_budget_cents)`, ≥1. The number of concurrent $150 test ad sets the cohort funds. |
| `buildAdsetTemplate({pixelId, targeting?})` | PURE — the ABO purchase-optimized spec every per-test ad set clones (only the CREATIVE varies across a cohort). |
| `DEFAULT_TEST_TARGETING` | The proven cold-test audience (US 18–65, home+recent, Advantage+ Audience on), cloned from Amazing Coffee's live MB test ad sets. |

## Model / invariants

- **Gated OFF by default.** `media_buyer_test_cohorts.adset_per_test` defaults `false` — the legacy single-shared-adset behavior is unchanged for existing cohorts (Superfood Tabs, Amazing Coffee). Only a provisioned cohort opts in.
- **Same audience across a cohort** — `adset_template.targeting` is cloned onto every per-test ad set so the CREATIVE is the only variable (textbook creative isolation).
- **No spend at provision time** — the campaign is PAUSED and no ad sets exist yet; the per-test ad sets are minted (ACTIVE, $150/day) by the replenish/publish path when Bianca fills a test slot.
- Inputs it needs (provisioning is a curated step): the account's `meta_ad_accounts.id` UUID + Meta act id, the Facebook `pageId`, and the `pixelId` to optimize against.

## Related

[[media-buyer-agent]] · [[meta-ads]] (`getOrCreateTestingCampaign` / `createAdSet`) · [[../tables/media_buyer_test_cohorts]] · [[../reference/meta-scaling-methodology]] · [[../reference/meta-scaling-methodology#the-decision-tree]]
