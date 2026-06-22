# libraries/storefront-calibration

The conservative-mode gate for the storefront bandit, read from M3 (the LTV-proxy reconciler, `storefront-ltv-proxy-reconciler`).

**File:** `src/lib/storefront/calibration.ts` · See [[../goals/storefront-optimizer]].

## Exports

### `isConservative(workspaceId)` → `Promise<boolean>`
Returns whether the bandit should run conservatively (smaller bets + tighter promote thresholds). Reads M3's (future) `storefront_ltv_calibration` row; a non-null `calibrated_at` → no longer conservative. **Defaults to `true`** whenever the signal is absent/unreadable (M3 not built yet) — the safe direction per the goal's "run conservatively until the slow loop calibrates once" rule.

## Gotchas
- The `storefront_ltv_calibration` table does NOT exist yet — this is the M3 contract. The try/catch makes the absence a conservative default, not an error. Flip behavior automatically lands when M3 ships that table.
