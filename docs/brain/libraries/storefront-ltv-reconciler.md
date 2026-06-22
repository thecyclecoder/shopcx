# libraries/storefront-ltv-reconciler

The **slow loop** of the storefront LTV-proxy reconciler (M3, Phase 3) — the supervisor that catches the [[storefront-ltv-metrics|fast-loop]] proxy lying. For each past cohort whose decision-time proxy snapshot is now ≥ the ~4-month renewal lag old, it computes the **actual** realized margin-per-visitor from orders/renewals and compares it to the proxy recorded at decision time, then recalibrates the proxy weights and feeds the [[storefront-lever-memory|M2 memory]].

**File:** `src/lib/storefront/ltv-reconciler.ts` · Writes [[../tables/storefront_ltv_reconciliations]] + [[../tables/storefront_ltv_calibration]] · Driven by [[../inngest/storefront-ltv-reconcile]] · See [[../goals/storefront-optimizer]], spec `docs/brain/specs/storefront-ltv-proxy-reconciler.md` (Phase 3).

## Exports

### `reconcileLtvProxy({ workspaceId, lagDays?, windowDays?, marginFraction?, now?, admin? })` → `Promise<ReconcileResult>`
Reconciles every past cohort whose **earliest** [[../tables/storefront_ltv_metrics]] snapshot (the proxy "recorded at decision time") is now ≥ `lagDays` (default `DEFAULT_RECONCILE_LAG_DAYS = 120`) old and that hasn't been reconciled yet. For each:
1. Rebuilds the exposed visitors at decision time (`experiment_exposure` ≤ snapshot day) → their attributed orders within the purchase window → the converting customers.
2. **Actual LTV** = `Σ getCustomerStatsBatch(customers).ltv_cents × margin_fraction ÷ proxy visitors` — full realized history, capturing the ~4 months of renewals.
3. Writes a [[../tables/storefront_ltv_reconciliations]] row (`proxy_ltv_cents`, `actual_ltv_cents`, `error_pct`, `weights_version`, dominant `lever_key`).
4. **Recalibrates:** fits a correction = visitor-weighted `Σ actual ÷ Σ proxy` (clamped `[0.25, 4]`), composes it onto `sub_ltv_factor`, **bumps `weights_version`**, and flips `calibrated_at` on the first reconciliation — upserted to [[../tables/storefront_ltv_calibration]].
5. **Escalates** `|error_pct| ≥ 0.5` (`ESCALATION_ERROR_PCT`) on a sufficiently-sampled cohort to [[../functions/growth|Growth]] (`escalated=true` + structured ESCALATION log).

Returns `{ candidates, reconciled[], recalibrated, weights_version, sub_ltv_factor, calibrated_at, escalations[] }`.

### Constants
- `DEFAULT_RECONCILE_LAG_DAYS = 120` — the ~4-month renewal lag before a cohort's actual LTV is meaningful.
- `MIN_CONVERTERS_FOR_RECALIBRATION = 5` — below this a cohort is recorded but excluded from the weight fit + escalation (`flags.insufficient_actual_sample`).
- `ESCALATION_ERROR_PCT = 0.5` — `|error_pct|` at/above this escalates to Growth.

## How the loop closes
- The recalibrated `sub_ltv_factor` is read back by [[storefront-ltv-metrics]] `predictedLtvPerVisitor` (via [[storefront-calibration]] `getCalibrationState`) and applied to the est-sub-LTV term — so a proxy the slow loop found over-predicts gets its subsequent rewards down-weighted, under a new auditable `weights_version`.
- The reconciliation rows are ingested by [[storefront-lever-memory]] `applyReconciliationSignal` (the M2 decay pass) — **cross-link, no hard dependency**: this loop just persists the signal; M2 reads it if present.

## Gotchas
- **Idempotent / one-time.** A cohort reconciles exactly once (unique cohort key); a re-run reconciles only newly-mature cohorts and only those bump the version — no churn.
- **Same denominator as the proxy.** Actual LTV divides by the metric row's stored `visitors` so it's apples-to-apples with `predicted_ltv_per_visitor_cents`.
- **No hardcoded economics.** Actual LTV uses the same flagged `margin_fraction` as the proxy until a real COGS source lands.
- **Visitor reconstruction is decision-time-anchored.** Exposures are filtered to `created_at ≤` end of the snapshot UTC day to approximate the cohort that was measured then — a documented approximation, not the exact running/promoted set at that instant.
