# libraries/storefront-experiment-attribution

Phase 3 of the storefront experiment framework: joins exposure → outcome per variant across the delayed-purchase window and persists idempotent rollups + the Thompson posterior onto [[../tables/storefront_experiment_variants]].

**File:** `src/lib/storefront/experiment-attribution.ts` · Reads [[../tables/storefront_events]] + [[../tables/orders]] · See spec.

## Exports

### `refreshExperimentAttribution({ workspaceId, experimentId?, windowDays?, now? })` → `AttributionRefreshResult`
For each `running`/`promoted` experiment's variants:
1. `experiment_exposure` events → per `variant_id`, exposed sessions keyed by `anonymous_id` + first-exposure time.
2. `order_placed` events (same session, carry `meta.order_id`/`total_cents`) within `windowDays` (default 14) AFTER first exposure → an attributed conversion (one per anon, earliest qualifying order).
3. Orders table (by `meta.order_id`) → authoritative `total_cents`, `subscription_id` (sub-attach), refund status.

Writes `sessions`/`conversions`/`sub_attach`/`revenue_cents`/`ltv_proxy_cents` + derived `alpha`/`beta`/`reward_sum`/`n`. **Idempotent — recomputes from source + overwrites; a re-run never double-counts.** Returns per-variant `VariantRollupResult[]` (incl. `refunds`) so the bandit acts without re-querying.

### Constants
`DEFAULT_WINDOW_DAYS` (14), `EST_SUB_LTV_CENTS` (12000 — placeholder incremental sub-LTV bonus the predicted-LTV proxy adds per sub-attach; **M3's reconciler recalibrates this weight**).

## Gotchas
- **Session/identity-keyed, not URL-parsed.** Orders has no `anonymous_id`; the `order_placed` event bridges session→order. Cross-session same-customer attribution is a future enhancement (assignment identity is `anonymous_id` anyway).
- **LTV proxy is recorded, not calibrated here** — `oneTimeRevenue + sub_attach × EST_SUB_LTV_CENTS`. [[../goals/storefront-optimizer]] M3 owns the real LTV math.
