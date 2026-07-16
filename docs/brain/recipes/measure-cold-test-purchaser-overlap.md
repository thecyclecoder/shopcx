# Measure existing-buyer contamination in cold-test adsets

The one-shot, dry-run-by-default script that produces the **cited overlap number** the M2 recent-purchaser exclusion is gated on ([[../goals/bianca-temperature-aware-campaign-structure]] M2). Without this row, the exclusion build has no defensible number — the goal's verify-scale-numbers rule refuses to ship an exclusion on a paper 40-50% estimate.

## Script

```bash
# dry-run (safe; no writes)
npx tsx scripts/_measure-cold-test-purchaser-overlap.ts

# write one audit row per cohort (idempotent same-UTC-day short-circuit)
npx tsx scripts/_measure-cold-test-purchaser-overlap.ts --apply

# widen or narrow the read window
npx tsx scripts/_measure-cold-test-purchaser-overlap.ts --window 60 --apply

# scope to one workspace (default: every active per-test cohort)
npx tsx scripts/_measure-cold-test-purchaser-overlap.ts --workspace <uuid> --apply
```

**File:** `scripts/_measure-cold-test-purchaser-overlap.ts`

## What it does

Enumerates every [[../tables/media_buyer_test_cohorts]] row where `adset_per_test = true AND is_active = true AND test_meta_campaign_id IS NOT NULL`, then per cohort:

1. Resolves the meta_ad_ids under `cohort.test_meta_campaign_id` via [[../tables/meta_ads]] (`meta_campaign_id = cohort.test_meta_campaign_id`).
2. Sums `attributed_spend_cents` from [[../tables/meta_attribution_daily]] for those ad ids over the last N days (default 30, `--window`).
3. Resolves the DISTINCT clicker set from [[../tables/storefront_events]] (`customer_id NOT NULL`, `meta->>utm_content = <meta_ad_id> OR url ILIKE '%utm_content=<meta_ad_id>%'`) + a belt-and-suspenders fallback over [[../tables/orders]] `attributed_utm_content`.
4. For each clicker, expands the linked group via `public.resolve_customer_link_group` (the same RPC [[../libraries/customer-timeline]] uses) and checks whether ANY order was placed BEFORE their first cold-test click — that clicker counts as a prior_purchaser.
5. Sums the attributed spend of the ads whose clickers were prior_purchasers — the leaked-spend proxy.

Writes ONE `media_buyer_purchaser_overlap_measured` [[../tables/director_activity]] row per cohort carrying `{ cohort_id, window_days, distinct_clickers, prior_purchasers, overlap_ratio, spend_cents_total, spend_cents_allocated_to_prior_purchasers, verdict, autonomous: true }`. `verdict` is `'proceed'` when `overlap_ratio ≥ 0.15` (the goal's threshold), else `'defer'`.

## Idempotency

Before insert, reads the newest overlap-measurement row for `(workspace_id, cohort_id)` via `director_activity` and short-circuits when the newest row is same UTC day — safe to re-run.

## Verdicts

- **proceed** — overlap ≥ 15%. The M2 exclusion build is defensible.
- **defer** — overlap < 15%. Exclusion is premature; widen the window or re-measure once the cohort has more spend.

## Gotchas

- **Dry-run by default.** The script prints per-cohort ratios + a summary; nothing hits `director_activity` until you pass `--apply` (or `APPLY=1`).
- **Storefront_events is the primary clicker source.** A conversion whose click never landed in `storefront_events` (pixel missed) is still captured via the orders fallback, but a pure-clicker with no purchase in that window depends on the pixel.
- **The linked-group expansion is per-clicker.** N clickers → N RPC calls. For a workspace with tens of thousands of clickers this is fine (the RPC is cheap); the script is a one-shot, not a hot path.

## Related

[[../libraries/media-buyer-agent]] · [[../tables/media_buyer_test_cohorts]] · [[../tables/meta_attribution_daily]] · [[../tables/storefront_events]] · [[../tables/orders]] · [[../tables/director_activity]] · [[../tables/meta_ads]] · [[../goals/bianca-temperature-aware-campaign-structure]]
