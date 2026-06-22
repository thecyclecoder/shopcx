# libraries/storefront-calibration

The conservative-mode gate for the storefront bandit, read from M3 (the LTV-proxy reconciler, `storefront-ltv-proxy-reconciler`). Reads the [[../tables/storefront_ltv_calibration]] row the slow-loop [[storefront-ltv-reconciler]] writes.

**File:** `src/lib/storefront/calibration.ts` · See [[../goals/storefront-optimizer]], [[../tables/storefront_ltv_calibration]].

## Exports

### `isConservative(workspaceId)` → `Promise<boolean>`
Returns whether the bandit should run conservatively (smaller bets + tighter promote thresholds). Reads [[../tables/storefront_ltv_calibration]]; a non-null `calibrated_at` → no longer conservative. **Defaults to `true`** whenever the signal is absent/unreadable (no reconciliation yet) — the safe direction per the goal's "run conservatively until the slow loop calibrates once" rule.

### `isProxyCalibrated({ workspaceId, productId? })` → `Promise<boolean>`
**THE single calibration gate** the M1 bandit + M4 agent read (Phase 4) to size bets / gate promote thresholds — the positive framing of `isConservative` (`isProxyCalibrated === !isConservative`). Product-grained signature (the spec's `isProxyCalibrated(product)`); calibration is conceptually per `(product)` but the slow loop currently calibrates at the WORKSPACE grain, so `productId` is accepted-and-echoed and resolution is workspace-wide (tightenable later without changing callers). **Defaults to `false`** (uncalibrated → conservative) when the signal is absent. Read by [[storefront-experiment-refresh]] (`refreshStorefrontExperiments` derives its `conservative` flag from it).

### `getCalibrationState(workspaceId)` → `Promise<{ calibrated, weights_version, sub_ltv_factor }>`
The signal the fast loop ([[storefront-ltv-metrics]] `refreshLtvMetrics`) reads when persisting a metric row:
- `calibrated` — `!!calibrated_at` (true once the slow loop reconciles once).
- `weights_version` — the proxy-weights version to stamp (Phase 3 bumps it on recalibration; `1` until then).
- `sub_ltv_factor` — the est-sub-LTV recalibration correction the fast loop applies (`1` until the first reconciliation; < 1 down-weights an over-predicting proxy).

Reads defensively — before any reconciliation it returns the conservative defaults `{ false, 1, 1 }`.

## Gotchas
- **Absence = conservative.** The try/catch + null-coalescing make a missing [[../tables/storefront_ltv_calibration]] row (or table) a conservative default, not an error.
- **The factor closes the loop.** `sub_ltv_factor` is what makes a recalibration actually move the reward, not just stamp a new version — applied to the est-sub-LTV term in [[storefront-ltv-metrics]].
