# inngest/storefront-experiments

The bandit-refresh loop for the storefront experiment framework (Phases 4–5 of the storefront-experiment-bandit-framework spec). Recomputes attribution, runs the rollback guardrail + Thompson-sampling decision, and writes the supervisable run record. Thin wrappers over [[../libraries/storefront-experiment-refresh]].

**File:** `src/lib/inngest/storefront-experiments.ts` · See [[../libraries/storefront-bandit]], [[../libraries/storefront-experiment-attribution]], [[../tables/storefront_experiment_runs]].

## Functions

### `storefront-experiments-refresh-cron`
- **Trigger:** cron `0 12 * * *` (daily, after the meta performance crons)
- **Retries:** 1
- Finds every workspace with a `running`/`promoted` [[../tables/storefront_experiments]] row and fires one `storefront/experiments-refresh` event each (`trigger: "cron"`).

### `storefront-experiments-refresh`
- **Trigger:** event `storefront/experiments-refresh`
- **Retries:** 2 · **Concurrency:** `[{ limit: 1, key: "event.data.workspace_id" }]`
- **Event data:** `{ workspace_id, trigger?: "cron"|"manual", window_days? }`
- Calls `refreshStorefrontExperiments()` — attribution recompute → Phase-5 rollback guardrail → Phase-4 promote/kill decision → run record. The manual-trigger entry point too (fire this event with `trigger:"manual"` to force a refresh).
- After the rollup it fires `storefront/ltv-metrics-refresh` (`step.sendEvent`) to recompute the M3 predicted-LTV-per-visitor metric ([[storefront-ltv-metrics]]) on the fresh attribution.
- **Edge-manifest self-heal:** the per-workspace pass also unconditionally `republishExperimentManifest(admin)` (gated on `isEdgeConfigWriteConfigured()`) after the rollup, so `storefront_experiment_manifest` in Edge Config always reflects the live running/promoted set within ≤5 min regardless of how state drifted — the safety net for the state-change-only fast path. Idempotent. See [[../libraries/storefront-experiment-refresh]] · [[../specs/pdp-edge-served-experiments]].

## Gotchas
- **Conservative until M3 calibrates.** Reads `isConservative()` ([[../libraries/storefront-calibration]]) per run; tighter promote thresholds + a higher exposure floor until the LTV-proxy reconciler lands.
- **Supervisable.** Every promote/kill/rollback writes its posterior snapshot + rule to [[../tables/storefront_experiment_runs]]; rollbacks also escalate to Growth (durable `escalations` + structured `console.warn`).
