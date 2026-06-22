# `storefront_ltv_calibration` — the calibrated gate + recalibration correction

One row per workspace: whether the predicted-LTV proxy has been truth-checked by the slow loop (`calibrated_at`), the current proxy `weights_version`, and the est-sub-LTV correction (`sub_ltv_factor`) the fast loop applies. Written by [[../libraries/storefront-ltv-reconciler]] (`reconcileLtvProxy`) on each recalibration; read by [[../libraries/storefront-calibration]] (`getCalibrationState` + `isConservative`) — both DEFAULT to uncalibrated when the row is absent. Migration `20260626120000_storefront_ltv_reconciler.sql`. RLS: workspace-member SELECT, service-role write. Part of [[../goals/storefront-optimizer]] (M3). See spec `docs/brain/specs/storefront-ltv-proxy-reconciler.md` (Phase 3).

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` | uuid → workspaces | cascade; the unique upsert key (one row per workspace) |
| `calibrated_at` | timestamptz \| null | non-null once the slow loop reconciles once — **THE calibrated gate**; while null the bandit runs conservatively |
| `weights_version` | int | current proxy-weights version; bumped each recalibration that lands new reconciliations |
| `sub_ltv_factor` | double | recalibration correction the fast loop multiplies onto `est_sub_ltv` (1.0 until first reconciliation; < 1 down-weights an over-predicting proxy) |
| `last_error_pct` | double \| null | visitor-weighted aggregate signed error across reconciled cohorts at the last recalibration (audit) |
| `reconciled_cohorts` | int | count of sufficiently-sampled cohorts reconciled into the current version (audit) |
| `created_at` / `updated_at` | timestamptz | |

**Indexes:** unique `(workspace_id)` — one calibration row per workspace, the upsert target.

## Gotchas
- **Absence = conservative.** Before any reconciliation the row doesn't exist; `getCalibrationState`/`isConservative` read it defensively and default to `calibrated=false`, `weights_version=1`, `sub_ltv_factor=1` — the safe direction.
- **The factor closes the recalibration loop.** [[../libraries/storefront-ltv-metrics]] reads `sub_ltv_factor` and applies it to the est-sub-LTV term of `predicted_ltv_per_visitor`, so a recalibration actually moves the reward (not just the stamped version). Stored in each metric row's `flags.sub_ltv_factor` for audit.
- **Version bumps only on new reconciliations.** A reconciler run that finds no newly-mature cohort leaves this row untouched — no version churn.
