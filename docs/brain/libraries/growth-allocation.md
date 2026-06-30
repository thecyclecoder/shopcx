# libraries/growth-allocation

Cross-tool allocation brain (Meta vs Storefront). Phase 1 readers + Phase 2 composer + Phase 3 director-activity stamp + box-lane wiring. The Growth Director's decide-layer: one typed allocation decision per (workspace, ad-account) per day, audited via [[../tables/director_activity]].

**File:** `src/lib/growth-allocation.ts` · Wired into the [[meta-performance]] `meta-iteration-run` chain as stage 8 (post-`execute`) so the allocation decision lands AFTER the iteration engine settles its same-day Meta actions.

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

### `composeAllocationDecision({workspaceId, blended, metaSignal, storefrontSignal, ceilingState})` → `AllocationDecision`
Pure composer (Phase 2). Maps the M2 blended-CAC↔LTV objective + each tool's marginal-leverage signal + the active ad-spend ceiling state into ONE typed `AllocationDecision` (`reallocate_within_ceiling | hold | no_useful_lever | escalate_ceiling_raise | escalate_new_platform`). The Goodhart guard: a Meta scale-up whose estimated marginal ROAS would DEGRADE the blended target is rejected (`hold`) instead of executed.

### `runGrowthAllocationPass({workspaceId, adAccountId, snapshotDate})` → `RunGrowthAllocationPassResult`
Phase 3 — the end-to-end daily allocation pass per (workspace, ad-account). Resolves the active `ad_spend_budgets` ceiling (window + cents), snapshots the blended objective ([[blended-cac-ltv]]) + the current rolling spend ([[ad-spend-governor]] `rollupAdSpendActual`) for the same window, runs both Phase-1 readers, calls `composeAllocationDecision`, then:
- writes a [[../tables/director_activity]] row (`director_function='growth'`) with the per-decision `action_kind` and the full `{ decision, evidence, ceiling_state, blended, flags, snapshot_date, autonomous:true }` metadata.
- For `escalate_*` kinds, fires [[platform-director]] `escalateDiagnosisToCeo` so the CEO inbox lights up (`escalationKind='budget_raise'|'new_platform'`), deduped per (escalationKind, workspace, ad-account).

Action-kind vocabulary (open vocabulary on [[../tables/director_activity]]):
- `allocated_spend` — `reallocate_within_ceiling` (Meta scale_up or Storefront promote).
- `allocation_no_useful_lever` — `hold` (Goodhart-rejected Meta lever) or `no_useful_lever` (neither tool has signal).
- `escalated_ceiling_raise` — `escalate_ceiling_raise` (Meta wants to scale, would breach the ceiling — CEO's call).
- `escalated_new_platform` — `escalate_new_platform` (ceiling tapped, blended healthy, no useful lever — open a new channel).

## Gotchas
- **Engine outputs only.** Meta-side reads the persisted scorecards + recommendations — never raw `meta_insights_daily` / `meta_attribution_daily`. Same trace-by-id invariant the rest of the iteration engine respects.
- **`running` only on the storefront side.** Promoted / killed / rolled-back experiments aren't candidates — they have no open lever to pull.
- **No active iteration_policies row degrades safely** to `DEFAULT_SCALE_UP_ROAS_TRIGGER=1.5` (a flag is emitted) — mirrors the decision-engine's "no policy → degrade safely" pattern.
- **Pure scorers are deterministic** — fixture inputs map to a single expected score. Phase 2's composer pins on these to test allocation-decision branches without needing a database.

## Status

Fully shipped and wired (verified 2026-06-30). The phase 3 allocation pass runs daily as stage 8 of the [[../inngest/meta-performance]] `meta-iteration-run` chain, post-execute.

---

[[../README]] · [[growth-director]] · [[ad-spend-governor]] · [[blended-cac-ltv]] · [[meta__iteration-run]] · [[../inngest/meta-performance]] · [[../tables/director_activity]]
