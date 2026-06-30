# winning-creative-detect

Phases 1–3 of the [[../specs/growth-winning-creative-amplifier]] amplifier — finds winning
`(meta_ad_id, variant)` cells over our own [[../tables/meta_attribution_daily]] and joins each
to its source [[../tables/ad_campaigns]] + [[../tables/product_ad_angles]] row, amplifies each
winner via the makers pipeline, and opens a matched-lander draft experiment for advertorial-family
winners. STRICTLY our own data — no external ad-intelligence integrations are read here.

**Code:** `src/lib/ads/winning-creative-detect.ts` · **Tests:** `src/lib/ads/winning-creative-detect.test.ts`

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

`detectWinners` is **pure read** — it never writes. The Phase 2 amplifier consumes the output and
writes the new `ad_campaigns` rows.

## Exports

### `detectWinners(admin, opts)` → `DetectedWinner[]` (Phase 1)
The detector described above. Pure read.

### `amplifyWinner(admin, { workspaceId, winner, n, ... })` → `AmplifyWinnerResult` (Phase 2)
Per winner, enqueues up to `n` variant ad-campaign rows at `status='ready'` so the
`growth-adopt-creative-makers` ready-to-test queue picks them up. Caps:
`MAX_VARIANTS_PER_WINNER=4`, `MAX_AMPLIFICATIONS_PER_DAY=8`. Writes one
[[../tables/director_activity]] row of `action_kind='amplified_winner'`. After a successful
amplification, attempts the Phase 3 forward pair (below) — best-effort; a pair failure never
unwinds the amplification.

### `pairAmplifiedWinnerWithLander(admin, opts)` → `PairAmplifiedWinnerResult` (Phase 3, forward)
For an advertorial-family winner (variant ∈ {`advertorial`, `before_after`, `beforeafter`,
`listicle`, `reasons`}), opens a storefront experiment via
[[optimizer-agent|materializeOptimizerCampaign]] at `status='draft'` (owner-approved before
serving) with the winner's hook/mechanism packed into the
[[storefront-experiments|VariantPatch]] (headline ← `meta_headline` or `hook_one_liner`;
dek ← `meta_primary_text`; chapterHeading ← `hook_one_liner`). Stamps ONE
[[../tables/director_activity]] row of `action_kind='paired_winner_lander'` carrying
`{ direction:'ad_to_lander', source_meta_ad_id, lander_type, experiment_id, patch, ... }`.
Skips with `{ok:false, reason}` for non-advertorial-family variants (PDP / unknown), a missing
source product, or an optimizer surface that already has an active campaign.

The REVERSE direction (a promoted lander variant → fresh static via
[[optimizer-agent#pairPromotedLanderWithAd|pairPromotedLanderWithAd]]) lives in
[[optimizer-agent]] and fires from the experiment-refresh promote path.

### Helpers

- `landerTypeForAmplifiedWinner(variant)` — `advertorial|beforeafter|listicle` or null.
- `patchFromWinnerAngle(angle)` — pure mapping from a `product_ad_angles` row to a
  `VariantPatch`. Returns `{}` when the angle is null.
- `archetypeForVariant(variant)` — normalize a lander-variant slug to the killer-statics
  archetype set the maker pipeline accepts.
- `planAmplificationVariants(source, n)` — pure planner deciding the per-winner static/video
  mix.

## Cross-links

[[../tables/meta_attribution_daily]] · [[../tables/ad_campaigns]] · [[../tables/product_ad_angles]] · [[../tables/director_activity]] · [[meta__attribution]] · [[blended-cac-ltv]] · [[optimizer-agent]] · [[storefront-experiments]] · [[../specs/growth-winning-creative-amplifier]] · [[../functions/growth]]
