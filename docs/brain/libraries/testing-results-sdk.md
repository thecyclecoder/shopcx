# `src/lib/ads/testing-results-sdk.ts`

The read-only lens behind **`/ad-testing-results`** (the skill) and the **Analytics → Ad Testing** page. One row per **test** (an ad set) across **every** hero product, grouped **product → test campaign**, sorted **crowning-potential → early dud**. It answers "which tests are winning, which are dying, is the structure sane?" without any caller hand-rolling a Graph call, a raw join, or purchase-counting. Contrast [[ad-insights-sdk]] (per-ad, per-account, live `last_30d`, the [[../../.claude/skills/ads-analysis/SKILL.md|/ads-analysis]] path).

## Why a DB source (not a live pull)

Numbers are **cumulative-lifetime** from [[../tables/meta_insights_daily]] (adset level), kept **fresh + TODAY-inclusive** by the 2-hourly [[../inngest/media-buyer-test-cadence]] cron — the **same numbers [[media-buyer-agent|Bianca]] acts on**, so the report and the agent never disagree. Deliberately **not** `last_30d` (Meta's `last_30d` ends yesterday and drops today's ~$6/hr-per-test spend — the exact stale-data trap that made a manual analysis wrong on 2026-07-13).

## `getTestingResults(admin, workspaceId, nowMs?) → TestingResults`

Composes five reads:

1. **Mapping** — active [[../tables/media_buyer_test_cohorts]] rows: `product_id → meta_ad_account_id + test_meta_campaign_id`. This is the DB that tells Bianca WHERE to publish each product's test. A cohort with a null `test_meta_campaign_id` falls back to its `test_meta_adset_id`'s parent campaign (legacy shape).
2. **Structure** — every ad set under those campaigns from [[../tables/meta_adsets]] (`effective_status`), so $0 / paused tests still show. Ad sets that never ran ($0 **and** not ACTIVE) are dropped as skeletons.
3. **Metrics** — Σ [[../tables/meta_insights_daily]] (adset, 180d lookback): spend, impressions, clicks, add_to_cart, purchases, revenue → derived CPM, CTR, cost-per-ATC, CAC.
4. **Attribution** — ad set → product via `ad_publish_jobs.meta_adset_id → campaign_id → ad_campaigns.product_id` (single-cohort-product fallback). Attributes each ad set individually, so a campaign that (wrongly) serves two products still splits correctly.
5. **Creative** (DB snapshot) — the current `ad_publish_jobs` copy + `ad_campaigns.hero_image_url`, per ad set.

Returns `{ generatedAt, thresholds, products: ProductTestGroup[], globalFlags, freshness }`, products sorted best-tier first.

## Tiers — DERIVED from `iteration_policies`, never hardcoded

`resolveTestThresholds` reads the active [[../tables/iteration_policies]] row (the SAME knobs [[media-buyer__meta-cpa-signal|the crown/trim signal]] uses); `tierForTest` applies them:

- **👑 crown** — `≥ crown_min_purchases` sales AND CAC ≤ `crown_max_cpa_cents` AND spend ≥ `crown_min_spend_cents` (default 8 / $150 / $450).
- **📈 promising** — CAC ≤ `hold_band_max_cpa_cents` ($220) — converting, high crowning potential.
- **💀 dud** — spend ≥ `max_test_spend_cents` (deadline $1,200) without reaching the hold band, OR spend ≥ `early_trim_min_spend_cents` ($300) with 0 sales, OR (**slow-kill over-CPA converter, CEO 2026-07-15**) spend ≥ `slow_kill_min_spend_cents` ($600) AND CAC > `slow_kill_max_cpa_cents` ($300) — order-safe on top of crown/promising because $300 sits above the $150 crown and $220 hold-band ceilings, so a slow-kill state can never be crown/promising. A converter with CAC between $220 and $300 stays `testing` (skeptic v3 $226 near-miss protection preserved).
- **⏳ testing** — everything else (early / accumulating).

`compareTests` sorts crown → promising → testing → dud, then sales desc, CAC asc, cost-per-ATC asc, CTR desc. Unit-tested in `src/lib/ads/testing-results-sdk.test.ts` (`npx tsx --test`).

## `enrichWithMetaCreatives(rows, token, metaGraphRequest, opts?)`

Overlays the **live Meta creative** onto each row's `creative` — `thumbnail_url` (grid thumbnail), `image_url` (modal), and `object_story_spec.link_data` (current headline / primary / description / link). The publish-row copy is a stale snapshot (copy edited on Meta after publish, and the render image, aren't in our DB), so this is the SSOT for what the ad actually shows now. READ-ONLY Graph reads, concurrency-pooled, best-effort (a failed read keeps the DB snapshot). `opts.onlyActive` bounds the fan-out — the Ad Testing page enriches only ACTIVE tests.

## Structure flags (surfaced, never mutated)

`globalFlags`: a test campaign serving >1 product (the Ashwavana Guru Focus + Zen Relax defect); a cohort with no product mapping (legacy single-adset — why that product's tests don't publish). Per-product `flags`: >`MAX_ACTIVE_TESTS_PER_CAMPAIGN` (4) active tests.

## Consumers

- `scripts/ad-testing-results.ts` — the CLI ([[../../.claude/skills/ad-testing-results/SKILL.md]]).
- `GET /api/workspaces/[id]/analytics/ad-testing` → the **Analytics → Ad Testing** page ([[../dashboard/ad-testing]]).

## Related

[[ad-insights-sdk]] · [[media-buyer-agent]] · [[media-buyer__meta-cpa-signal]] · [[../tables/media_buyer_test_cohorts]] · [[../tables/meta_insights_daily]] · [[../tables/meta_adsets]] · [[../inngest/media-buyer-test-cadence]] · [[../reference/meta-scaling-methodology]] · [[../functions/growth]]
