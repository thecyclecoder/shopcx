# `storefront_ltv_metrics` — predicted-LTV-per-visitor, the bandit's reward

One row per `(workspace × product × lander_type × audience × snapshot_date)`: the fast-loop **predicted-LTV-per-visitor** the [[../goals/storefront-optimizer|storefront optimizer]] (M3) optimizes — the REWARD the [[storefront_experiments|M1 bandit]] decides on instead of raw CVR. Written by [[../libraries/storefront-ltv-metrics]] (`refreshLtvMetrics`), driven daily by [[../inngest/storefront-ltv-metrics]] right after the M1 attribution rollup. Migration `20260625120000_storefront_ltv_metrics.sql`. RLS: workspace-member SELECT, service-role write. Part of [[../goals/storefront-optimizer]] (M3). See spec `docs/brain/specs/storefront-ltv-proxy-reconciler.md` (Phase 2).

`predicted_ltv_per_visitor_cents = ((one_time_conversions × one_time_margin_cents) + (sub_conversions × est_sub_ltv_cents)) ÷ visitors`. Because sub-LTV ≫ one-time, the metric naturally rewards turning visitors into subscribers.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` / `product_id` | uuid → workspaces / products | cascade |
| `lander_type` | text | the experiment lander type (`pdp` \| `listicle` \| `beforeafter` \| `advertorial`) |
| `audience` | text | audience key (default `'all'`) |
| `snapshot_date` | date | UTC snapshot day — part of the idempotent upsert key |
| `visitors` | int | distinct identities exposed to the cohort's experiments (the denominator); a visitor in several of the cohort's experiments counts once |
| `one_time_conversions` | int | converting visitors whose attributed order was a one-time purchase |
| `sub_conversions` | int | converting visitors whose attributed order carried a `subscription_id` |
| `sub_attach_rate` | double | `sub_conversions ÷ converting sessions` (exposure-attributed) |
| `est_sub_ltv_cents` | bigint | Phase-1 renewal-derived [[../libraries/storefront-ltv-proxy]] `estimateSubLTV` (product-level), NOT the flat attribution placeholder |
| `one_time_margin_cents` | bigint | mean MARGIN per one-time conversion = `round(margin_fraction × mean one-time order revenue)` |
| `predicted_ltv_per_visitor_cents` | bigint | the headline reward (see formula above) |
| `margin_fraction` | double | the margin fraction used (placeholder until a real COGS source — flagged) |
| `weights_version` | int | the proxy-weights version this row was computed under; Phase 3 bumps it on recalibration (auditable / reproducible) |
| `calibrated` | bool | `false` until M3's slow loop (Phase 3) reconciles once; downstream runs conservatively while false |
| `est_sub_ltv_sample_size` | int | realized subscribers sampled for `est_sub_ltv_cents` (low-confidence when small) |
| `flags` | jsonb | `cogs_source_missing`, `audience_not_segmentable`, `insufficient_sub_history`, `no_exposures`, plus the applied `sub_ltv_factor` (Phase-3 recalibration correction) — honest, never guessed |
| `created_at` / `updated_at` | timestamptz | |

**Indexes:** unique `(workspace_id, product_id, lander_type, audience, snapshot_date)` — the snapshot/upsert key; `(workspace_id, snapshot_date desc)` — the dashboard week-over-week read.

## Gotchas
- **Idempotent.** The daily refresh UPSERTS on the snapshot key, so a re-run (or a manual re-trigger) for the same day overwrites — never double-writes.
- **Reward, not objective.** This is a bounded proxy the slow-loop reconciler (Phase 3) supervises against actual 4-month cohort LTV; a large persistent proxy-vs-actual error escalates to the [[../functions/growth|Growth director]], never silently absorbed ([[../operational-rules]] § North star).
- **Differs from the per-variant proxy.** [[storefront_experiment_variants]]`.ltv_proxy_cents` uses a flat `EST_SUB_LTV_CENTS` placeholder; this metric uses the real renewal-derived `estimateSubLTV`. Phase 3 reconciles + recalibrates the weights both stamp.
- **No hardcoded economics.** `margin_fraction` is the flagged Phase-1 placeholder until a real per-product COGS source exists (`flags.cogs_source_missing`).
- **Uncalibrated until Phase 3.** On first runs `calibrated=false` and `weights_version=1` (the initial version) — the metric is honest that the proxy hasn't been truth-checked yet.
