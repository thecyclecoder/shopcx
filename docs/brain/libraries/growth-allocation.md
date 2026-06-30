# libraries/growth-allocation

Cross-tool allocation brain (Meta vs Storefront) — Phase 1: pure-ish marginal-leverage readers per tool. The Growth Director's decide-layer (Phase 2 composer + Phase 3 `director_activity` stamp) consumes these to emit ONE typed allocation decision per day.

**File:** `src/lib/growth-allocation.ts` · Driven by `runGrowthDirectorJob` (Phase 3, hung off `meta-iteration-run`) · See `docs/brain/specs/growth-allocation-brain.md`.

## Exports

### `readMetaMarginalLeverage({workspaceId, adAccountId, snapshotDate})` → `MetaMarginalLeverageResult`
Surveys Meta's marginal-leverage signal — the next-dollar opportunity space — for one workspace × ad-account on one snapshot day. Reads ONLY the engine's persisted outputs (not the raw insights tables), same invariant as [[meta-decision-engine]]:
- [[../tables/iteration_scorecards_daily]] adset/campaign rows where current-window ROAS ≥ active policy's `scale_up_roas_trigger` (or `DEFAULT_SCALE_UP_ROAS_TRIGGER=1.5`) AND not fatigued (`ctr_declining=false` + `frequency_rising=false`) → `source:'scorecard_scale_up'` evidence with the scorecard's ROAS as the marginal-ROAS estimate.
- Pending [[../tables/iteration_recommendations]] of type `new_static_adset` / `new_video_adset` / `new_campaign` → `source:'pending_recommendation'` evidence using the engine-stamped `source_metrics.expected_roas` (or sibling keys). A recommendation that ships without any marginal-ROAS estimate is flagged, never silently scored.

`metaScore` = max `estimated_marginal_roas` across all evidence; `null` + `no_signal_meta` flag when nothing qualifies.

### `readStorefrontMarginalLeverage({workspaceId})` → `StorefrontMarginalLeverageResult`
Surveys the storefront tool's marginal-leverage signal. For every `running` [[../tables/storefront_experiments]] row, reads `last_decision` (written by [[storefront-experiment-refresh]] off the [[storefront-bandit]] posteriors). Picks the highest-winProb non-control arm and emits:
- `win_prob` (posterior P(arm > control))
- `ltv_lift_per_session_cents` = winning-arm `ltvPerSession` − control `ltvPerSession`
- `expected_lift_cents` = `win_prob × max(lift, 0)` (no negative scores — a control-beats-arm experiment still records evidence but scores 0)

`storefrontScore` = max `expected_lift_cents` across running experiments; `null` + `no_signal_storefront` flag when nothing has a usable last_decision. Experiments with `delivery_flag='failed_to_deliver'` are skipped (mirrors the bandit's same refusal in [[storefront-experiment-delivery-audit]]).

### `scoreMetaMarginalLeverage({...})`, `scoreStorefrontMarginalLeverage({...})`
Pure scorers — DB-free, take the already-fetched inputs (scorecards/recommendations/scaleUpRoasTrigger; experiments). The data-layer readers above are thin wrappers that fetch then call these. Unit-tested in `src/lib/growth-allocation.test.ts` (`npm run test:growth-allocation`).

## Gotchas
- **Engine outputs only.** Meta-side reads the persisted scorecards + recommendations — never raw `meta_insights_daily` / `meta_attribution_daily`. Same trace-by-id invariant the rest of the iteration engine respects.
- **`running` only on the storefront side.** Promoted / killed / rolled-back experiments aren't candidates — they have no open lever to pull.
- **No active iteration_policies row degrades safely** to `DEFAULT_SCALE_UP_ROAS_TRIGGER=1.5` (a flag is emitted) — mirrors the decision-engine's "no policy → degrade safely" pattern.
- **Pure scorers are deterministic** — fixture inputs map to a single expected score. Phase 2's composer pins on these to test allocation-decision branches without needing a database.
