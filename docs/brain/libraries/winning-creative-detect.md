# winning-creative-detect

Phase 1 of the [[../specs/growth-winning-creative-amplifier]] amplifier — finds winning
`(meta_ad_id, variant)` cells over our own [[../tables/meta_attribution_daily]] and joins each
to its source [[../tables/ad_campaigns]] + [[../tables/product_ad_angles]] row so the Phase 2
amplifier knows the archetype + angle to clone. STRICTLY our own data — no external
ad-intelligence integrations are read here.

**Code:** `src/lib/ads/winning-creative-detect.ts` · **Function:** `detectWinners(admin, { workspaceId, sinceMs?, minSpendCents?, minRoas?, targetCacLtv?, topK?, amazonHaloMultiplier?, nowMs? })` → `DetectedWinner[]`

## Behavior

1. Pulls every [[../tables/meta_attribution_daily]] row for the workspace in
   `[now - sinceMs, now]` (default 14 days, UTC `snapshot_date`).
2. Groups by `(meta_ad_id, variant)`, summing `attributed_spend_cents`, `revenue_cents`, and
   `sessions`. The `(unresolved)` variant is excluded — it can't be amplified back to a real
   lander.
3. Scores each cell as `ROAS = (onsiteCents × amazonHaloMultiplier) / spendCents`. The Amazon
   halo is applied as an optional workspace-level multiplier — it is not attributable per
   Meta ad (see [[acquisition-roas]] for where the per-line halo lives).
4. Filters by **both** floors:
   - `spendCents ≥ minSpendCents` (default 5_000¢ = $50 — below this per-row ROAS is noise).
   - `roas ≥ minRoas` (default = `targetCacLtv × 1.2`, i.e. the workspace's blended setpoint
     plus a 20% safety margin; targetCacLtv defaults to `DEFAULT_BLENDED_CAC_LTV_TARGET = 3×`).
5. Returns the top-K cells (default 10) by ROAS desc, tie-breaking by spend desc so the
   higher-confidence winner wins.
6. Joins each winner's dominant `ad_campaign_id` + `angle_id` (picked by row count) onto its
   [[../tables/ad_campaigns]] + [[../tables/product_ad_angles]] row. A cell whose joins can't
   resolve still appears in the output with `campaign = null` / `angle = null`.

The function is **pure read** — it never writes. The Phase 2 amplifier consumes the output and
writes the new `ad_campaigns` rows.

## Cross-links

[[../tables/meta_attribution_daily]] · [[../tables/ad_campaigns]] · [[../tables/product_ad_angles]] · [[meta__attribution]] · [[blended-cac-ltv]] · [[../specs/growth-winning-creative-amplifier]] · [[../functions/growth]]
