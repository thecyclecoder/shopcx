# `storefront_ltv_reconciliations` — proxy-vs-actual, the slow-loop truth-check

One row per reconciled cohort `(workspace × product × lander_type × audience × cohort_snapshot_date)`: the **actual** 4-month realized margin-per-visitor vs the **predicted-LTV proxy** recorded at decision time, plus the signed error and the dominant lever class. Written by [[../libraries/storefront-ltv-reconciler]] (`reconcileLtvProxy`), driven daily by [[../inngest/storefront-ltv-reconcile]]. Read independently by the [[../libraries/storefront-lever-memory|M2 memory]] (`applyReconciliationSignal`) as its recalibration signal. Migration `20260626120000_storefront_ltv_reconciler.sql`. RLS: workspace-member SELECT, service-role write. Part of [[../goals/storefront-optimizer]] (M3). See spec `docs/brain/specs/storefront-ltv-proxy-reconciler.md` (Phase 3).

`error_pct = (actual_ltv_cents − proxy_ltv_cents) ÷ max(proxy_ltv_cents, 50)`. **> 0 ⇒ the proxy UNDER-predicted** (the lever mattered more than the proxy thought); **< 0 ⇒ the proxy OVER-predicted** (e.g. discount-heavy subs churned below the estimate).

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` / `product_id` | uuid → workspaces / products | cascade |
| `lander_type` | text | the cohort's lander type |
| `audience` | text | audience key (default `'all'`) |
| `cohort_snapshot_date` | date | the decision-time [[storefront_ltv_metrics]] `snapshot_date` reconciled — part of the idempotent cohort key |
| `proxy_ltv_cents` | bigint | predicted-LTV proxy recorded at decision time (per exposed visitor) |
| `actual_ltv_cents` | bigint | actual realized margin per exposed visitor as of reconciliation (~4 months later) |
| `error_pct` | double | signed relative error (see formula above) |
| `weights_version` | int | the proxy-weights version the reconciled metric row was computed under (auditable) |
| `lever_key` | text \| null | the dominant lever class of the cohort's experiments — the M2 recalibration signal |
| `visitors` | int | exposed visitors (the proxy denominator) |
| `converting_customers` | int | converting customers sampled for actual LTV |
| `margin_fraction` | double | margin fraction applied to realized revenue (placeholder until a real COGS source — flagged) |
| `escalated` | bool | `|error_pct| ≥ 0.5` on a sufficiently-sampled cohort — surfaced to [[../functions/growth|Growth]], not absorbed |
| `flags` | jsonb | `insufficient_actual_sample`, `ltv_includes_full_customer_history` |
| `created_at` / `updated_at` | timestamptz | |

**Indexes:** unique `(workspace_id, product_id, lander_type, audience, cohort_snapshot_date)` — the one-time cohort/upsert key; `(workspace_id, created_at desc)` — the M2 intake + dashboard read.

## Gotchas
- **Reconciles exactly once.** The unique cohort key makes reconciliation idempotent — a re-run skips already-reconciled cohorts and never re-bumps the [[storefront_ltv_calibration]] `weights_version`.
- **Actual reuses full customer history.** `actual_ltv_cents` sums each converting customer's *entire* realized LTV (`getCustomerStatsBatch`) × `margin_fraction` over the proxy's visitor denominator — the spec's sanctioned realized-orders source (`flags.ltv_includes_full_customer_history`). It captures the ~4 months of renewals the proxy could only estimate.
- **Low-sample cohorts are recorded but not acted on.** Below 5 converting customers the row carries `flags.insufficient_actual_sample=true` and is excluded from the weight fit and from escalation (still persisted for audit).
- **The supervisor, not the objective.** A large persistent error escalates to [[../functions/growth|Growth]] ([[../operational-rules]] § North star) — `escalated=true` + a structured ESCALATION log — never silently absorbed.
