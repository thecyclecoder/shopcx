# Quant-desk reweight loop — from author-stamped combination back to the picker

The [[../goals/v3-ad-creative-engine]] goal's M5 "attribution + learning loop (the 'quant desk')" milestone closes the loop from the CREATIVE the author-mode session stamped, through the ROLLUP that measures its ROAS/CPA/CTR at significance, to the PICKER that re-weights the next pick on those numbers, back out to the AUDIT ROW that lets the CEO retrace the decision.

This page traces the full end-to-end so a future reader knows where every piece sits without hunting through six specs.

## Cast

| Surface | Where | Purpose |
|---|---|---|
| Combination stamp | [[insertReadyCreative]] via [[wire-engine-into-dahlia-author-path]] Phase 3 | The ad-creative author-mode session stamps `ad_campaigns.creative_combination_id` on every ok-verdict creative — the anchor every downstream aggregator keys on. |
| Attribution snapshot | [[../tables/meta_attribution_daily]] | Per-`meta_ad_id` daily settled spend / orders / revenue — the raw money-and-outcome grain the rollup reduces. |
| Factor rollup | [[../libraries/factor-rollup-sdk]] `getFactorRollup` | Aggregates the attribution snapshot per `{combination, theme, pattern}`, stamps every row with `significance.passesGate` — the significance-gated verdict. |
| Threshold resolver | [[../libraries/factor-rollup-policies]] `resolveFactorRollupThresholds` | Reads the workspace-tunable `[[../tables/factor_rollup_policies]]` row (`min_spend_cents`, `min_purchases`, `max_acceptable_cpa_cents`) with code defaults ($200 / 5 / $250). |
| Picker | [[../libraries/selection-engine]] `pickNextCombination` | The 70/30 explore/exploit split; both branches consult the rollup output. |
| Audit trail | [[../libraries/director-activity]] `recordDirectorActivity` | One `director_activity` row per pick with `action_kind='media_buyer_selection_reweighted'`. |
| Dashboard read | Growth's Cleo cockpit (M6, forthcoming) | Reads the same rollup for the founder-facing "which factor scores are winning?" surface. |

## The loop

1. **Author** — Dahlia's per-creative box session produces a rendered ad, `insertReadyCreative` stamps `ad_campaigns.creative_combination_id`, `creative_theme`, `headline_pattern_id`, `angle_palette_id`. The row is now anchored on the four axes the rollup reduces.
2. **Publish + spend** — the media-buyer cadence promotes the row live; Meta's Insights sync writes daily `meta_attribution_daily` snapshots keyed on `meta_ad_id`. Spend, orders, revenue accumulate.
3. **Rollup** — the next call to `getFactorRollup(workspace, product, lookbackDays=30)` joins the two shapes, aggregates per `{combination, theme, pattern}`, stamps `significance.passesGate` on every row using the resolved workspace thresholds.
4. **Reweight (exploit)** — `pickExploitCombination` filters `byCombination` to `passesGate=true && roas != null`, ranks by ROAS desc / purchases desc / spend_cents desc, resolves the top row back to `{angle, pattern, theme}`, returns with `exploitSource:'factor_rollup_roas'` + `biasedByFactors` naming the winning numbers verbatim. Cold-start → `palette_status_crown_fallback`.
5. **Reweight (fresh)** — `pickFreshCombination` applies three rails BEFORE the freshness-cooldown ledger fires:
   - Drops combinations whose passesGate rollup has `cpa_cents > LOSER_CPA_FLOOR_DEFAULT_CENTS` (workspace-tunable via `max_acceptable_cpa_cents`).
   - Prefers non-loser themes when a legal shot exists (loser theme quota is halved).
   - Excludes patterns whose passesGate rollup has `ctr < PATTERN_FATIGUE_CTR_FLOOR` (0.008).
   - Stamps `filteredByFactors` on the return so the audit trail cites every dropped combination / halved theme / excluded pattern.
6. **Audit** — `pickNextCombination` writes ONE `director_activity` row per pick under `director_function='growth'` with `action_kind='media_buyer_selection_reweighted'`; metadata carries `product_id`, `temperature`, `intent`, `exploit_source`, `biased_by_factors`, `filtered_by_factors`, `chosen_combination_id`, `chosen_angle_id`, `chosen_pattern_id`, `autonomous:true`.
7. **Retrace** — the founder (or Cleo's dashboard) reads the audit row to see WHICH numbers biased the pick. No silent proxy-optimization — the [[../operational-rules.md#north-star]] supervisable-autonomy rail is honored.

## Why the significance gate matters

Without the gate, a two-purchase lucky day at $10 CPA would crown a combination and starve every alternative. The gate ($200 spend AND 5 purchases in the window, workspace-tunable) is the guardrail: a row cannot bias the picker until it has enough real money behind it that the CPA/CTR/ROAS is not noise. The `factor_rollup_policies.confidence` axis is reserved for the follow-on statistical-gate work; today's gate is spend + purchases.

## Related

- [[../specs/factor-scores-reweight-selection-engine.md]] — this loop's spec.
- [[../specs/factor-rollup-sdk-with-significance-gate.md]] — the significance verdict this loop's exploit branch reads.
- [[../specs/selection-engine-coverage-ledger.md]] — the two READERS (`listEligibleCombinations` + `readLiveBinThemeDistribution`) the picker's rail sits on.
- [[../specs/wire-engine-into-dahlia-author-path.md]] — where the combination stamp is written that the rollup keys on.
- [[../goals/v3-ad-creative-engine]] M5.
