# Predicted-LTV-per-visitor metric + 4-month actual-LTV reconciler ⏳

**Owner:** [[../functions/growth]] · **Parent:** M3 — Predicted-LTV metric + 4-month reconciler

The objective function for the [[../goals/storefront-optimizer]] and its truth-check. Optimizing raw CVR or AOV is a Goodhart loss; the real objective is **predicted-LTV-per-visitor** = `(one-time conversions × one-time margin) + (subscription conversions × estimated-sub-LTV)`. Because sub-LTV ≫ one-time, this metric *naturally* teaches the agent to turn visitors into subscribers, not just buyers. But with monthly renewals, true LTV isn't known for **~4 months** — so this milestone builds **two loops**: a **fast loop** that computes the proxy `sub-attach-rate × estimated-sub-LTV (+ one-time margin)` per `(product × lander-type × audience)` for the bandit to decide on at significance, and a **slow loop** (~4-month lag) that reconciles each past cohort's *actual* renewal LTV against the proxy and **recalibrates** the proxy weights + the lever-importance map (e.g. "discount-heavy offers over-predict — those subs churn"). It exposes an `uncalibrated` flag until the slow loop has calibrated once, so the [[storefront-experiment-bandit-framework|M1 bandit]] runs conservatively until then. This is the reward signal M1/M4 decide on and the proof the proxy didn't lie.

## Phase 1 — estimated-sub-LTV + sub-attach inputs ⏳
- ⏳ planned
- `src/lib/storefront/ltv-proxy.ts` — `estimateSubLTV({product_id, audience})` derived from real subscription history (renewal survival × per-renewal margin), and `subAttachRate(cohort)` (subscription conversions ÷ converting sessions). Today no estimated-sub-LTV/sub-attach computation exists — the [[../dashboard/analytics__roas|ROAS dashboard]] is a stub and [[../libraries/customer-stats]] `getCustomerLTV` is live **per-customer** (orders-to-date), not predictive or cohort-level. Reuse `getCustomerStatsBatch` for the realized-orders inputs; reuse subscription tables for renewal survival.
- One-time margin input: per-product COGS/margin (coordinate with the CFO COGS source; if absent, parameterize and flag — do not hardcode).

## Phase 2 — the fast-loop predicted-LTV-per-visitor metric ⏳
- ⏳ planned
- `predictedLtvPerVisitor(cohort)` = `(one_time_conversions × one_time_margin) + (sub_conversions × estimateSubLTV)` ÷ visitors, computed per `(product × lander-type × audience)` over the M1 exposure→outcome stream ([[storefront-experiment-bandit-framework]] Phase 3 rollups + [[../tables/storefront_events]] `experiment_exposure`).
- Persist into `storefront_ltv_metrics` (keyed `(workspace_id, product_id, lander_type, audience, snapshot_date)`, carrying `visitors`, `sub_attach_rate`, `est_sub_ltv_cents`, `one_time_margin_cents`, `predicted_ltv_per_visitor_cents`, the proxy `weights_version`, and `calibrated bool`). This is the **reward** the bandit reads — M1's significance test runs on `predicted_ltv_per_visitor`, not CVR. Migration + [[write-brain-page]] `tables/storefront_ltv_metrics.md`.
- Daily Inngest refresh after the M1 attribution rollup; idempotent upsert on the snapshot key.

## Phase 3 — the slow-loop 4-month actual-LTV reconciler ⏳
- ⏳ planned
- `src/lib/storefront/ltv-reconciler.ts` — for each past cohort whose first exposure is now ≥ ~4 months old, compute **actual** realized cohort LTV from orders/renewals (`getCustomerStatsBatch` + renewal history) and compare to the proxy recorded at decision time. Persist a `storefront_ltv_reconciliations` row (`cohort key`, `proxy_ltv_cents`, `actual_ltv_cents`, `error_pct`, `weights_version`).
- **Recalibrate:** fit corrected proxy weights from the proxy-vs-actual error (e.g. discount-heavy cohorts that over-predicted get their est-sub-LTV down-weighted), bump `weights_version`, and emit the corrected lever-importance signal to the [[storefront-lever-importance-memory|M2 memory]] (cross-link, no hard dependency — M2 reads the signal if present).
- Flip `calibrated=true` once the first reconciliation lands; before that the metric reports `uncalibrated` so M1 runs conservatively.

## Phase 4 — surfacing + the conservative-until-calibrated flag ⏳
- ⏳ planned
- Surface predicted-LTV-per-visitor per `(product × lander-type × audience)` week-over-week on the [[../dashboard/storefront__funnel|funnel dashboard]] (and feed the [[../dashboard/analytics__roas|ROAS dashboard]] the same est-sub-LTV it currently lacks).
- Export a single `isProxyCalibrated(product)` the M1 bandit + M4 agent read to gate bet size / promote thresholds.

## Safety / invariants
- **Proxy is a bounded reward, never the objective.** The reconciler is the supervisor that catches the proxy lying ([[../operational-rules]] § North star); a large persistent proxy-vs-actual error escalates to the [[../functions/growth|Growth director]], it is not silently absorbed.
- **No hardcoded economics.** COGS/margin and renewal-survival inputs come from real data sources; if a source is missing it is parameterized + flagged, never guessed.
- **Conservative until calibrated.** `calibrated=false` ⇒ smaller bets + tighter promote thresholds downstream.
- **Idempotent.** Metric + reconciliation rows upsert on stable keys; a re-run never double-writes.
- **Weights are versioned.** Every metric row stamps the `weights_version` it was computed under, so a recalibration is auditable and a past decision is reproducible.

## Completion criteria
- `estimateSubLTV` + `subAttachRate` compute from real subscription/orders history for Amazing Coffee.
- `storefront_ltv_metrics` populates `predicted_ltv_per_visitor` per `(product × lander-type × audience)` daily, idempotently, and the M1 bandit decides on it.
- The reconciler computes actual cohort LTV at the ~4-month lag, records proxy-vs-actual error, and recalibrates proxy weights (bumping `weights_version`).
- `calibrated` flips true after the first reconciliation; `isProxyCalibrated` gates downstream bet size.
- Predicted-LTV-per-visitor is surfaced week-over-week on the funnel dashboard.

## Verification
- Apply the migration → expect `✓ public.storefront_ltv_metrics has N columns` (+ `storefront_ltv_reconciliations`); confirm columns + the snapshot-key unique index in Supabase.
- Run the fast-loop refresh for Amazing Coffee → `select product_id, lander_type, audience, sub_attach_rate, est_sub_ltv_cents, predicted_ltv_per_visitor_cents, calibrated from storefront_ltv_metrics order by snapshot_date desc;` → expect rows per `(product × lander-type × audience)` with a positive `predicted_ltv_per_visitor_cents` and `calibrated=false` on first run; re-run → row count stable (idempotent).
- Confirm the M1 bandit reads `predicted_ltv_per_visitor` as its reward (not CVR) — its significance test references the metric row id.
- Backdate a test cohort ≥ 4 months and run the reconciler → expect a `storefront_ltv_reconciliations` row with `proxy_ltv_cents`, `actual_ltv_cents`, `error_pct`, and a bumped `weights_version`; `calibrated` flips to true and subsequent metric rows carry the new weights version.
- On `/dashboard/storefront/funnel` → expect predicted-LTV-per-visitor shown week-over-week per `(product × lander-type × audience)`.
- Induce a large proxy-vs-actual error on a reconciled cohort → expect a Growth-director escalation logged, not a silent absorb.
