# libraries/storefront-experiment-attribution

Phase 3 of the storefront experiment framework, **rewritten for [[../lifecycles/storefront-session-attribution]]**: attributes off the **session stamp** (not the flaky client `experiment_exposure` event) and persists idempotent rollups + the Thompson posterior onto [[../tables/storefront_experiment_variants]].

**File:** `src/lib/storefront/experiment-attribution.ts` · Reads [[../tables/storefront_sessions]] (`experiment_assignments`) + [[../tables/orders]] (`session_id`) · Trace: [[../lifecycles/storefront-session-attribution]].

## Exports

### `refreshExperimentAttribution({ workspaceId, experimentId?, windowDays?, now? })` → `AttributionRefreshResult`
For each `running`/`promoted` experiment's variants — **session-stamped, in-session, literal**:
1. **Sessions** = `storefront_sessions` whose `experiment_assignments` carries that variant's arm (paged via the `.contains` jsonb `@>` filter), **excluding `is_internal`/`is_bot`** (the report-layer exclusion). A session is in ≤1 arm per experiment, may span experiments.
2. **Conversion** = an `orders` row whose `session_id` is one of those stamped sessions (earliest order per session wins — a session counts once). No `windowDays` window — it's in-session. (`windowDays` is retained for API compat but ignored.)
3. The order supplies authoritative `total_cents`, `subscription_id` (sub-attach), refund status.

Writes `sessions`/`conversions`/`sub_attach`/`revenue_cents`/`ltv_proxy_cents` + derived `alpha`/`beta`/`reward_sum`/`n`. **Idempotent — recomputes from source + overwrites; a re-run never double-counts.** Returns per-variant `VariantRollupResult[]` (incl. `refunds`) so the bandit acts without re-querying.

### Constants
`DEFAULT_WINDOW_DAYS` (14 — now only mirrored by [[storefront-ltv-metrics]]), `EST_SUB_LTV_CENTS` (12000 — placeholder incremental sub-LTV bonus the predicted-LTV proxy adds per sub-attach; **M3's reconciler recalibrates this weight**).

## Gotchas
- **Session-stamped, not exposure-event-keyed.** The old spine (distinct `anonymous_id` that fired `experiment_exposure`, + a 14-day `order_placed` match) under-fired badly (3/110 sessions) — replaced by the `storefront_sessions.experiment_assignments` stamp + the first-class `orders.session_id` link.
- **Internal/bot are excluded HERE, not at write.** Sessions are stamped regardless of `is_internal`/`is_bot` (previews/QA stay inspectable); this lib filters `is_internal=false, is_bot=false`. [[storefront-experiment-funnel]] mirrors the filter.
- **LTV proxy is recorded, not calibrated here** — `oneTimeRevenue + sub_attach × EST_SUB_LTV_CENTS`. [[../goals/storefront-optimizer]] M3 owns the real LTV math.
