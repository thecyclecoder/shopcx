# `src/lib/ads/selection-engine.ts`

The **v3 portfolio selector** for Dahlia's next (angle × pattern × combination) shot. The 70/30 explore/exploit split every ad-creative loop pass rides — plus the significance-gated factor rollup that biases both branches so the picker chooses on real ROAS/CPA numbers, not a decayed palette flag.

## What it exposes

- **`listEligibleCombinations({admin, workspaceId, productId, temperature, nowIso?})`** — the fresh, cooldown-eligible (past the ~45-day [[../tables/ad_creative_combinations]] `COOLDOWN_DAYS`) combinations joined against the fresh, temperature-serving [[angle-palette]] rows and the temperature-legal, consumes-fillable [[headline-patterns]] rows. One deterministic view of "what can we ship right now?"
- **`readLiveBinThemeDistribution({admin, workspaceId, productId})`** — the live map from `creative_theme` → count of `ad_campaigns.status='ready'` rows for this (workspace, product). The quota axis theme-spread measures against; a NULL-themed row surfaces under a separate `null` key.
- **`pickNextCombination(args)`** — the 70/30 picker composed of `pickExploitCombination` (exploit branch, 30%) and `pickFreshCombination` (explore branch, 70%). Every return writes one `director_activity` row (see § Reweight audit trail).
- **`pickExploitCombination(args, rollup?)`** — Phase-1 exploit slot: ranks the rollup's `byCombination` rows on `significance.passesGate` + ROAS desc / purchases desc / spend_cents desc via `rankSignificancePassedByRoas`, resolves the top row back to `{angle, pattern, theme}` via the palette + patterns SDKs, and returns with `exploitSource:'factor_rollup_roas'` + `biasedByFactors` naming the winning combination's numbers verbatim. Cold-start / not-yet-tested product → falls back to the palette `status='crowned'` pick with `exploitSource:'palette_status_crown_fallback'` so the caller never starves silently.
- **`pickFreshCombination(args, rollup?)`** — Phase-2 explore slot: filters the eligible set by three rollup-informed rails and returns the first survivor. See § Rollup reweight below.

## Reweight loop — how factor scores bias the pick

The [[../specs/factor-scores-reweight-selection-engine.md]] spec closes the v3 goal's quant-desk loop: `getFactorRollup` from [[factor-rollup-sdk]] returns per-`{combination, theme, pattern}` CPA/CTR/ROAS numbers gated with `significance.passesGate` (workspace-tuned via [[factor-rollup-policies]] — $200 / 5 purchases default). The selection engine consults the SAME rollup on both branches:

### Exploit slot (Phase 1)
The 30% exploit branch replaces the pre-Phase-1 crowned-status flag with real ROAS numbers: the highest-ROAS passesGate row wins. Cold-start falls back to the pre-Phase-1 crowned pick so nothing regresses.

### Fresh slot (Phase 2)
The 70% fresh branch applies three rollup-informed filters/dampers BEFORE the freshness-cooldown ledger fires:
- **`combinationLoserExcluded`** — a combination whose passesGate rollup has `cpa_cents > LOSER_CPA_FLOOR_DEFAULT_CENTS` ($250 code default, workspace-tunable via [[../tables/factor_rollup_policies]] `max_acceptable_cpa_cents`) is DROPPED from the fresh sample regardless of palette status. A proven money loser doesn't burn budget while waiting for [[creative-learning]]'s outcome-ledger `MAX_FAILED_COMBOS_BEFORE_RETIRE` count to catch up.
- **`themeQuotaHalved`** — a theme whose `byTheme` rollup is a passesGate high-CPA loser gets its per-theme `readyBinCap` halved; the picker prefers non-loser themes when a legal shot exists elsewhere.
- **`patternFatigueExcluded`** — a pattern whose `byPattern` rollup is passesGate + `ctr < PATTERN_FATIGUE_CTR_FLOOR` (0.008 default) is dropped from the legal-pattern set for the temperature.

Each decision stamps `filteredByFactors` on the return so the Phase-3 audit trail can cite the numbers verbatim.

## Reweight audit trail (Phase 3)

Every `pickNextCombination` return writes ONE `director_activity` row via `recordDirectorActivity` ([[director-activity]]):
- `action_kind='media_buyer_selection_reweighted'`
- `director_function='growth'` (owned by the Growth director — [[../functions/growth]])
- `metadata` = `{ product_id, temperature, intent, exploit_source, biased_by_factors, filtered_by_factors, chosen_combination_id, chosen_angle_id, chosen_pattern_id, autonomous:true }`

The row lets a founder (or a coach) retrace which factor scores biased the pick — the north-star supervisable-autonomy rail: no silent proxy-optimization. See the end-to-end trace in [[../lifecycles/quant-desk-reweight-loop]].

## Named constants (tunable knobs)

| Constant | Default | Purpose |
|---|---|---|
| `COOLDOWN_DAYS` | 45 | Per-combination cooldown horizon (spec: [[../specs/selection-engine-coverage-ledger.md]]) |
| `EXPLOIT_RATIO` | 0.3 | The 70/30 explore/exploit split the v3 goal names |
| `EXPLOIT_LOOKBACK_DAYS` | 30 | Days back the exploit slot scopes the factor-rollup read to |
| `LOSER_CPA_FLOOR_DEFAULT_CENTS` | 25000 ($250) | Fresh-branch loser floor when a workspace has no `factor_rollup_policies.max_acceptable_cpa_cents` row |
| `PATTERN_FATIGUE_CTR_FLOOR` | 0.008 (0.8%) | Fatigue floor a passesGate pattern must clear to stay in the legal-pattern set |

## Related

[[factor-rollup-sdk]] · [[factor-rollup-policies]] · [[creative-learning]] · [[angle-palette]] · [[headline-patterns]] · [[creative-combinations]] · [[director-activity]] · [[../lifecycles/quant-desk-reweight-loop]] · [[../specs/factor-scores-reweight-selection-engine.md]]
