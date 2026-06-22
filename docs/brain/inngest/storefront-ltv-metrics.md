# inngest/storefront-ltv-metrics

The fast-loop refresh for the predicted-LTV-per-visitor metric (Phase 2 of the storefront-ltv-proxy-reconciler spec, M3). Thin wrapper over [[../libraries/storefront-ltv-metrics]] `refreshLtvMetrics`.

**File:** `src/lib/inngest/storefront-ltv-metrics.ts` · See [[../tables/storefront_ltv_metrics]], [[../libraries/storefront-ltv-metrics]], [[storefront-experiments]].

## Functions

### `storefront-ltv-metrics-refresh`
- **Trigger:** event `storefront/ltv-metrics-refresh`
- **Retries:** 2 · **Concurrency:** `[{ limit: 1, key: "event.data.workspace_id" }]`
- **Event data:** `{ workspace_id, window_days? }`
- Computes predicted-LTV-per-visitor for every active `(product × lander_type × audience)` cohort and upserts [[../tables/storefront_ltv_metrics]] (the bandit's reward). Idempotent — re-running a snapshot day overwrites.

## How it's triggered
- **Not its own cron.** [[storefront-experiments]] `storefront-experiments-refresh` fires `storefront/ltv-metrics-refresh` (via `step.sendEvent`) immediately AFTER its per-workspace attribution rollup completes — so the metric always reads the fresh attribution the spec requires ("daily refresh after the M1 attribution rollup"), with no cron-timing race. A manual experiments-refresh re-trigger cascades here too (idempotent, safe).

## Gotchas
- **Uncalibrated until M3 Phase 3.** Each row stamps `calibrated` + `weights_version` from [[../libraries/storefront-calibration]] `getCalibrationState`; both stay at the conservative default (`false` / `1`) until the slow-loop reconciler lands.
