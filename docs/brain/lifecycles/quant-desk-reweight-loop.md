# Quant-desk reweight loop — from author-stamped combination back to the picker

The **v3 Ad Creative Engine** goal's M5 "attribution + learning loop (the 'quant desk')" milestone closes the loop from the CREATIVE the author-mode session stamped, through the ROLLUP that measures its ROAS/CPA/CTR at significance, to the PICKER that re-weights the next pick on those numbers, back out to the AUDIT ROW that lets the CEO retrace the decision.

This page traces the full `quant-desk` reweight loop end-to-end so a future reader knows where every piece sits without hunting through six specs.

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

## Status / open work — v3 Ad Creative Engine goal (folded complete 2026-07-22)

✅ **Goal complete + folded (2026-07-22): [[../functions/growth|Growth]]'s v3 Ad Creative Engine** — the rebuild of the Dahlia/Max/Bianca ad-creative system into a coherent, closed-loop FACTOR MODEL ("quant for media buying"): Product → Ingredient → THEME → demand-sourced problem-ANGLE × shared PATTERN library × product-agnostic competitor SKELETON = a stamped, measured, re-weighted creative (HEADLINE = angle × pattern × optional skeleton; the 5 caption variations = 5 patterns on one angle). All six milestones landed; every child spec shipped|folded. The durable mechanics live in the pages this trace links; the preserved `public.goals` row is the narrative record. **Design principles (decided — do not re-derive):** DEMAND selects the angle / scientific evidence REINFORCES it (`evidence_tier` is a proof STYLE, never a filter; `role='skip'` is not a hard exclusion); angles keyed on PROBLEM (one ingredient fans across many problem-lanes; double-backed problems are strongest); skeleton is SCAFFOLD-not-substance (per-copy-section reuse verdict computed at AUTHOR time per product, never stored); the decision engine is FUNCTION-PRESERVING SUBSTITUTION, TEMPERATURE-KEYED (cold strips promo → value/proof/risk-reversal; warm/hot KEEP the offer slot filled with our REAL Max-verified offer); selection is theme-spread (hard — kills mono-angle convergence) + demand-weighted gap-fill + fresh-pattern-legal-for-temperature, ~70/30 explore/exploit; every posted ad is STAMPED `{theme, angle, pattern, combination}` so a factor rollup can attribute CPA/CTR behind a significance gate.

- **M1 — Foundation (angle palette + pattern library + compose engine).** The three factor tables — [[../tables/product_angle_palette]], [[../tables/ad_headline_patterns]], [[../tables/ad_creative_combinations]] (migration `20261123120000`, factor stamps + RLS) — plus the compose SDKs [[../libraries/angle-palette]] / [[../libraries/headline-patterns]] / [[../libraries/compose-headline]] (~13-pattern seed + all 14 Amazing Creamer angles seeded).
- **M2 — Wire the engine into Dahlia + seed all 6 products.** The demand feeder [[../libraries/angle-demand-sweep]] (daily [[../inngest/angle-demand-sweep-cadence]] grounding `search_demand` in real search volume + surfacing draft angles for uncovered high-tier ingredient×problem lanes), the [[../libraries/selection-engine]] (theme-spread + coverage ledger + freshness cooldown + explore/exploit blend), and the author-path wiring that makes every author-mode creative carry the four factor stamps ([[../libraries/creative-agent]] — `creative_theme`, `angle_palette_id`, `headline_pattern_id`, `creative_combination_id`). All 6 hero SKUs seeded.
- **M3 — Retarget campaign live (warm/hot).** Bianca's THIRD campaign — one lean consolidated adset, warm+hot MIXED content (mechanism/reviews/UGC + our REAL offer promo/risk-reversal), on its own kill-switch + heartbeat: [[../tables/media_buyer_retarget_cohorts]] + the [[../libraries/media-buyer-retarget-cohort]] SDK chokepoint (sibling of the cold-rail cohort resolver in [[../libraries/media-buyer-publish-gate]], never touching the cold-only invariant of Bianca's replenish loop).
- **M4 — Decision engine + agnostic skeleton redesign.** Temperature-keyed function-preserving substitution with Max re-scoped as the substitution supervisor (no empty slot / honest fill / no leak / on-strategy — folded into [[../libraries/creative-agent]] + [[../libraries/compose-headline]]); the skeleton recast to an AGNOSTIC WIREFRAME (`elements[]` = array of `{zone × role × prominence}`, scaffold-not-substance, per-copy-section reuse verdict computed at AUTHOR time) on [[../tables/creative_skeletons]] (migration `20261124120000`; substance columns kept only for the analyzed-competitor archive).
- **M5 — Attribution + learning loop (the 'quant desk').** *This lifecycle.* The factor-rollup SDK (`getFactorRollup` — per-`{combination, theme, pattern}` CPA/CTR/ROAS behind a significance gate resolved from [[../tables/factor_rollup_policies]]) whose scores re-weight [[../libraries/selection-engine]] `pickNextCombination` (exploit ranks passesGate winners by ROAS; fresh drops loser-CPA combinations + fatigued patterns), every pick audited to [[../libraries/director-activity]] `action_kind='media_buyer_selection_reweighted'`. See the loop traced above.
- **M6 — Products UI (make the engine visible).** The explore/exploit provenance + factor surface on the ad detail page ([[../dashboard/marketing__ads]] § Source, read off `product_ad_angles.metadata.provenance` written by [[../libraries/creative-agent]] `buildAngleProvenance`) + the product-intelligence panel ([[../dashboard/products]]) so an operator can see which theme/angle/pattern each creative was built from and which factors are winning.

**Success metric (the goal's own bar):** the bin/pins show genuine theme variety (not weight-loss every time); the retarget campaign is live with warm+hot mixed creative; the factor rollup shows which patterns/themes/angles win by CPA; the Max redo-rate on competitor-imitation drops; author-mode beats the prior path on realized cold CAC/CTR in Bianca's loop. Archived → [[../archive.d/goal-v3-ad-creative-engine|archive]].

**Open work:** the [[../tables/factor_rollup_policies]] `confidence` axis is reserved for a follow-on statistical significance gate (today's gate is spend + purchases); M6's founder-facing "which factor scores are winning?" cockpit is the read-mostly surface the rollup already backs.

## Related

- [[../specs/factor-scores-reweight-selection-engine.md]] — this loop's spec.
- [[../specs/factor-rollup-sdk-with-significance-gate.md]] — the significance verdict this loop's exploit branch reads.
- [[../specs/selection-engine-coverage-ledger.md]] — the two READERS (`listEligibleCombinations` + `readLiveBinThemeDistribution`) the picker's rail sits on.
- [[../specs/wire-engine-into-dahlia-author-path.md]] — where the combination stamp is written that the rollup keys on.
- **v3 Ad Creative Engine** goal M5 — folded complete 2026-07-22 (see § Status / open work above; [[../archive.d/goal-v3-ad-creative-engine|archive]]).
