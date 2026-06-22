# inngest/storefront-ltv-reconcile

The **slow-loop** 4-month actual-LTV reconciler (Phase 3 of the storefront-ltv-proxy-reconciler spec, M3). Thin wrapper over [[../libraries/storefront-ltv-reconciler]] `reconcileLtvProxy`.

**File:** `src/lib/inngest/storefront-ltv-reconcile.ts` · See [[../tables/storefront_ltv_reconciliations]], [[../tables/storefront_ltv_calibration]], [[../libraries/storefront-ltv-reconciler]], [[storefront-experiments]], [[storefront-lever-decay]].

## Functions

### `storefront-ltv-reconcile-cron`
- **Trigger:** cron `0 14 * * *` (daily 14:00 UTC)
- **Retries:** 1
- Finds every workspace with persisted [[../tables/storefront_ltv_metrics]] and fires one `storefront/ltv-reconcile` event each. Offset to 14:00 — AFTER the M1 attribution refresh (12:00, [[storefront-experiments]]) and the M2 decay (13:00, [[storefront-lever-decay]]) — so it judges fresh proxy rows. Emits a Control Tower heartbeat on every tick (incl. the empty path).

### `storefront-ltv-reconcile`
- **Trigger:** event `storefront/ltv-reconcile`
- **Retries:** 2 · **Concurrency:** `[{ limit: 1, key: "event.data.workspace_id" }]`
- **Event data:** `{ workspace_id, lag_days?, window_days? }`
- Reconciles each past cohort whose decision-time snapshot is now ≥ the ~4-month renewal lag old, records proxy-vs-actual error to [[../tables/storefront_ltv_reconciliations]], recalibrates the proxy weights ([[../tables/storefront_ltv_calibration]]), and escalates a large error to [[../functions/growth|Growth]].

## Gotchas
- **Cheap no-op most days.** Most runs find no newly-mature cohort; reconciliation is idempotent (a cohort reconciles exactly once), so a daily cadence never double-writes nor re-bumps the `weights_version`.
- **M2 ingests on its own pass.** The reconciliation rows are read by [[storefront-lever-memory]] `applyReconciliationSignal` during the [[storefront-lever-decay]] worker — cross-link, no hard dependency; this function only has to persist them.
