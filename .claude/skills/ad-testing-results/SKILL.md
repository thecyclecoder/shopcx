# ad-testing-results

The per-**test** funnel across **every** hero product — "which tests are winning, which are dying, and is the structure sane?" One row per test (an ad set), grouped by **product → test campaign**, sorted **crowning-potential → early dud**. This is the per-product companion to [[../ads-analysis/SKILL.md|/ads-analysis]] (which is per-ad, per-account, live-`last_30d`). Read-only.

## Run it

```
npx tsx scripts/ad-testing-results.ts
```

Prints, per product (with its ad account): every live/recently-run test with **CPM · spend · CTR · ATC · $/ATC · sales · CAC**, a verdict tier, then the structure issues + data freshness.

## Where the numbers come from — the important part

All composition/attribution lives in the SDK **`src/lib/ads/testing-results-sdk.ts`** (`getTestingResults`); the script is a thin renderer. The SDK composes five DB reads (no raw Graph, no hand-rolled purchase counting):

- **Mapping** product → account + test campaign ← [[../../docs/brain/tables/media_buyer_test_cohorts.md]] (the DB that tells **Bianca** WHERE to publish each product's test). A cohort with a null `product_id`/`test_meta_campaign_id` is the exact defect that leaves a product's tests unmapped.
- **Structure** every ad set (incl. $0 / paused) ← [[../../docs/brain/tables/meta_adsets.md]] (`effective_status`).
- **Metrics** cumulative-lifetime funnel per ad set ← Σ [[../../docs/brain/tables/meta_insights_daily.md]] (adset level). Kept **fresh + TODAY-inclusive** by the 2-hourly [[../../docs/brain/inngest/media-buyer-test-cadence.md]] cron — the **same numbers Bianca acts on**, so the report and the agent agree. **No `last_30d`** (which drops today's ~$6/hr-per-test spend).
- **Attribution** ad set → product ← `ad_publish_jobs.meta_adset_id → campaign_id → ad_campaigns.product_id`, single-cohort-product fallback. This attributes each ad set even inside a campaign that (wrongly) serves two products.
- **Creative** (page only) thumbnail + current copy ← the **live Meta creative** (`enrichWithMetaCreatives`), because the publish-row copy is a stale snapshot and the render image isn't in our DB.

## The verdict tiers — DERIVED from the live policy, never hardcoded

`tierForTest` reads the SSOT setpoints off the active [[../../docs/brain/tables/iteration_policies.md]] row (the SAME knobs the media-buyer's crown/trim signal uses — [[../../docs/brain/libraries/media-buyer-agent.md]]):

- **👑 Crown** — `≥ crown_min_purchases` sales AND CAC ≤ `crown_max_cpa_cents` AND spend ≥ `crown_min_spend_cents` (default ≥8 @ ≤$150 @ ≥$450).
- **📈 Promising** — converting within the hold band (`CAC ≤ hold_band_max_cpa_cents`, default $220) — high crowning potential.
- **⏳ Testing** — below the verdict floor, still accumulating.
- **💀 Dud** — spend past `max_test_spend_cents` (deadline, $1,200) without reaching the hold band, OR spend ≥ `early_trim_min_spend_cents` ($300) with **0 sales** (kill fast on the leading signal).

Sort: crown → promising → testing → dud; within a tier by sales desc, then CAC asc, then cost-per-ATC asc, then CTR desc.

## Structure issues it surfaces (never mutates)

- A **test campaign serving >1 product** (the Ashwavana Guru Focus + Zen Relax defect — one campaign should be one product).
- **>4 active tests** for a product (the ≤4-concurrent cap).
- A **cohort with no product mapping** (legacy single-adset shape — why Bianca can't publish that product's tests).

## The page

Analytics → **Ad Testing** (`/dashboard/analytics/ad-testing`, owner-only, read-only) renders the same SDK: grouped by product (badged with the ad account), each test a row with a **clickable creative thumbnail** → a modal showing the full image + headline + primary text + description + the funnel. See [[../../docs/brain/libraries/testing-results-sdk.md]].

## Related

[[../../docs/brain/libraries/testing-results-sdk.md]] · [[../ads-analysis/SKILL.md]] · [[../../docs/brain/tables/media_buyer_test_cohorts.md]] · [[../../docs/brain/tables/meta_insights_daily.md]] · [[../../docs/brain/inngest/media-buyer-test-cadence.md]] · [[../../docs/brain/reference/meta-scaling-methodology.md]] · [[../../docs/brain/functions/growth.md]]
