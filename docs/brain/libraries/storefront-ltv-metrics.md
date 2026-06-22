# libraries/storefront-ltv-metrics

Phase 2 of the predicted-LTV proxy reconciler (M3): the **fast loop**. Composes the Phase-1 inputs ([[storefront-ltv-proxy]] `estimateSubLTV`) into the predicted-LTV-per-visitor metric per `(product × lander_type × audience)` cohort and persists [[../tables/storefront_ltv_metrics]] — the REWARD the [[storefront-bandit|M1 bandit]] decides on instead of raw CVR.

**File:** `src/lib/storefront/ltv-metrics.ts` · Spec: [[../specs/storefront-ltv-proxy-reconciler]] · Goal: [[../goals/storefront-optimizer]] · Inngest: [[../inngest/storefront-ltv-metrics]].

## Exports

### `predictedLtvPerVisitor(cohort)` → `Promise<LtvPerVisitorResult>`
Computes the metric for ONE `(product × lander_type × audience)` cohort over the M1 exposure→outcome stream — `experiment_exposure` events ([[../tables/storefront_events]]) for the cohort's running/promoted experiments give the **visitors** (distinct exposed identities, deduped across the cohort's experiments), joined to `order_placed` + [[../tables/orders]] for the attributed conversions within the delayed-purchase window (`DEFAULT_WINDOW_DAYS = 14`). Splits conversions one-time vs subscription (off `orders.subscription_id`), then:

`predicted_ltv_per_visitor_cents = round(((one_time_conversions × one_time_margin_cents) + (sub_conversions × est_sub_ltv_cents)) ÷ visitors)`

where `est_sub_ltv_cents` is the Phase-1 renewal-derived `estimateSubLTV` (real subscription history, NOT the flat `EST_SUB_LTV_CENTS` placeholder the per-variant attribution proxy carries) and `one_time_margin_cents = round(margin_fraction × mean one-time order revenue)`. `cohort` = `{ workspaceId, product_id, lander_type, audience, marginFraction?, windowDays?, now?, subLtv?, subLtvFactor?, admin? }`. Pass `subLtv` to reuse one `estimateSubLTV` call across a product's cohorts. **`subLtvFactor`** (default `1`) is the Phase-3 recalibration correction multiplied onto the est-sub-LTV term — so a reconciled, over-predicting proxy yields a down-weighted reward.

### `refreshLtvMetrics({ workspaceId, windowDays?, marginFraction?, now? })` → `Promise<LtvMetricsRefreshResult>`
Daily fast-loop refresh: finds every active `(product × lander_type × audience)` cohort (distinct over running/promoted [[../tables/storefront_experiments]]), computes `predictedLtvPerVisitor` for each (one `estimateSubLTV` per product, cached), and UPSERTS one [[../tables/storefront_ltv_metrics]] row per cohort on the snapshot key — idempotent. Stamps `weights_version` + `calibrated` + applies `sub_ltv_factor` from the calibration signal ([[storefront-calibration]] `getCalibrationState`); the factor is persisted in the row's `flags.sub_ltv_factor`. Returns the per-cohort results.

### Constants
- `DEFAULT_WINDOW_DAYS = 14` — consider→buy attribution window (mirrors [[storefront-experiment-attribution]]).

## Gotchas
- **Runs after attribution.** Triggered by [[../inngest/storefront-experiments]] firing `storefront/ltv-metrics-refresh` AFTER its per-workspace attribution rollup — so the metric always reads fresh exposure→outcome data. Not its own cron (no timing race).
- **Idempotent upsert.** Re-running a snapshot day overwrites on `(workspace_id, product_id, lander_type, audience, snapshot_date)`; a manual re-trigger never double-writes.
- **Visitor dedup.** A visitor exposed to several of a cohort's experiments counts once (earliest exposure wins) — true unique visitors, not exposure-events.
- **Refunds not subtracted.** Mirrors the attribution proxy: the M1 Phase-5 guardrail owns refund-spike rollback, so the metric stays consistent with the reward the bandit already optimizes.
- **No hardcoded economics / uncalibrated until reconciled.** `margin_fraction` is the flagged Phase-1 placeholder until a real COGS source lands; `calibrated=false` + `weights_version=1` + `sub_ltv_factor=1` until the slow loop ([[storefront-ltv-reconciler]]) reconciles once, after which subsequent rows carry the bumped version + corrected factor.
