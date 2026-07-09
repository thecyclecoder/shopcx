# libraries/growth-director-analytical-brief

Phase 1 of [[../specs/growth-director-analytical-brief]] — the **cross-cohort analytical scorecard** the Growth Director will reason over (Phase 2). One row per **(cohort, creative, destination)** that JOINS the Meta side + the on-site funnel + per-variant ROAS at a single grain so a high-CTR / zero-ATC pattern becomes a first-class field instead of two dashboards Dylan has to read side-by-side (the 2026-07-08 live-read Coffee-carting / Tabs-cliff pattern that motivated the spec).

**File:** `src/lib/agents/growth-director-analytical-brief.ts` · Reads [[../tables/meta_insights_daily]] (Meta perf at ad grain) + [[../tables/meta_attribution_daily]] (per-variant attributed spend + revenue at ad grain) + [[../tables/meta_ads]] (labels + adset/campaign parents) + [[../tables/ad_publish_jobs]] (`meta_ad_id → campaign_id → destination_url`) + [[../tables/ad_campaigns]] (`product_id`) + [[../tables/products]] (handle + title — the COHORT) + [[../tables/storefront_sessions]] (`utm_content = meta_ad_id`, the on-site join key) + [[../tables/storefront_events]] (LPV/ATC/checkout/purchase). Read-only — never writes.

## The grain

- **Cohort** ← the product handle the ad's `ad_campaigns.product_id` resolves to. An ad that never went through the studio (set up directly in Meta Ads Manager) resolves to the sentinel cohort `unknown` — spend is never dropped; the sentinel is how the Director notices direct-in-Meta setups.
- **Creative** ← the Meta ad row (`meta_ads.meta_ad_id`). Same id [[../tables/meta_insights_daily]], [[../tables/meta_attribution_daily]], and [[../tables/storefront_sessions]] `utm_content` all key on — the join point that makes the scorecard possible.
- **Destination** ← the ad's `landing_url` (from [[../tables/ad_publish_jobs]] `destination_url`).

## Exports

- **`computeGrowthAnalyticalBrief({ admin, workspaceId, startIso, endIso, productHandles?, limit? })`** → `AnalyticalBriefResult` — the main entry. Rolls up every ad with in-window Meta spend at the four sources above (best-effort per table — a transient read failure zero's that dimension, never throws), then materializes:
  - `rows: CreativeScorecardRow[]` — one row per creative, sorted by spend desc, capped at `limit` (default 500). Each carries `meta: CreativeMetaMetrics` (spend / impressions / clicks / **CTR** / **CPC** / **CPM** / frequency / purchases / revenue / **ROAS** / **CPA**), `funnel: CreativeFunnel` (LPV / ATC / initiate_checkout / purchase — distinct sessions per stage), `dropoffs: CreativeDropoffs`, and `variants: VariantAttribution[]` (per-variant spend / revenue / ROAS / sessions / orders from [[../tables/meta_attribution_daily]]).
  - `cohorts: CohortSummary[]` — per-cohort rollup (creative count + summed meta + funnel totals) sorted by spend desc.
  - `unresolvedAdIds: string[]` — diagnostic list of `meta_ad_id`s that hit insights but couldn't be resolved to a product cohort (the direct-in-Meta setups). Used by the Phase-2 prompt to skip / narrate the gap.

- **`computeDropoffs(f: CreativeFunnel)`** → `CreativeDropoffs` — the pure stage-to-stage transition. Exposed for the Phase-2 hypothesis generator to reuse, and asserted in unit tests. Emits:
  - `lpv_to_atc_rate` / `atc_to_checkout_rate` / `checkout_to_purchase_rate` — child ÷ parent, clamped to `[0,1]`, **`null` when the parent is 0** (never fabricates a rate).
  - `lpv_to_atc_gap` / `atc_to_checkout_gap` / `checkout_to_purchase_gap` — absolute session gap parent − child (0-floored, so a stitching glitch that inverts child > parent still reads 0 rather than a negative).

- Const **`UNKNOWN_COHORT`** = `'unknown'` — the sentinel cohort exported so callers filter direct-in-Meta ads out of their prompts explicitly. Types **`AnalyticalBriefParams`**, **`AnalyticalBriefResult`**, **`CreativeScorecardRow`**, **`CreativeMetaMetrics`**, **`CreativeFunnel`**, **`CreativeDropoffs`**, **`VariantAttribution`**, **`CohortSummary`**.

## Real-traffic exclusion

Mirrors [[funnel-tree]] — before counting funnel stages, sessions get dropped when `is_internal=true`, `is_bot=true`, or the session's `customer_id` is on the workspace's `customers.is_internal=true` set. So the on-site side of the scorecard reflects real shoppers only and reconciles with the funnel-page card.

## Gotchas

- **`utm_content = meta_ad_id` is a publish-time convention, not a DB constraint** ([[../inngest/ad-tool]] sets `urlTags: 'utm_content={{ad.id}}'` at publish; Meta substitutes the real ad id per click). A creative published outside the studio without that tag will still have Meta insights but ZERO on-site funnel counts — the scorecard reads that as a pure "no destination attribution" case (funnel all-zero), NOT as a real cliff. The Phase-2 hypothesis generator gates the "funnel/destination suspect" call on a min-LPV floor to avoid mis-firing here.
- **CTR / CPC / CPM / frequency are ROLLED, not averaged from source columns.** `ctr` = clicks / impressions × 100 over the window; `cpc_cents` = spend / clicks; `cpm_cents` = spend / impressions × 1000 (dollars ×100 per 1k impressions — same unit convention as [[../tables/meta_insights_daily]]). Frequency is a per-day mean (Σ daily frequency / days seen) since Meta doesn't emit a rollable frequency.
- **CPA is `null`, not `0`, when there are no purchases** — surfaces the "spent but zero purchases" case as absent-data instead of misreading as $0 acquisition.
- **`variant='(unresolved)'` is a real row, not a gap** — mirrors [[../tables/meta_attribution_daily]]. An ad's spend on unresolved sessions surfaces so ROAS is never inflated.
- **Cohort=`unknown` is signal, not noise** — a large chunk of spend under `unknown` means most creatives were set up outside the studio; the Director should call it out.

## Related

- [[funnel-tree]] — the on-site funnel single-source-of-truth this brief reads at the ad grain (the tree is at the product/variant/angle grain — orthogonal axis).
- [[../libraries/meta__scorecards]] — the storefront iteration engine's daily scorecard at (level, object_id, snapshot_date) grain, persisted to [[../tables/iteration_scorecards_daily]]. THIS module is an **on-demand** brief for the Growth Director's reasoning; the iteration scorecards are the daily engine input.
- [[../libraries/growth-director]] — the director this scorecard feeds (Phase 2 will wire the brief into [[growth-director]] `buildGrowthDirectorBrief`).
- [[../specs/growth-director-analytical-brief]] — the spec.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
