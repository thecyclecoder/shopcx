# `src/lib/subscriber-experiment-metrics.ts` — per-arm net-revenue + secondary-metric rollup

The read-only MEASUREMENT surface for the pre-renewal-reminder 50/50 test. Spec: `subscriber-experiment-guardrails-verdict` **Phase 1**. Part of the [[../lifecycles/pre-renewal-reminder-journey]] flow (M3 "Self-running 50/50 test"). The Phase 2 guardrail evaluator and the Phase 3 verdict engine both read their numbers from here — nothing else computes per-customer net revenue over a window.

## Primary metric — 90-day net revenue per customer

`netRevenueCents = Σ orders.total_cents − Σ order_refunds.amount_cents (status ∈ succeeded|settled)` over the measurement window.

- **Charges** draw on [[../tables/orders]] `total_cents`.
- **Refunds** draw on [[../tables/order_refunds]] `amount_cents`, netting out ONLY settled money — statuses `succeeded` + `settled` (exported as `NETTED_REFUND_STATUSES`). `requested`/`failed`/`reversed` are EXCLUDED; counting money that never left would under-report real net revenue.
- `netRevenuePerCustomerCents` = arm total ÷ number of person-groups in the arm.

## Grain is the PERSON, not the account

Identical to the harness ([[subscriber-experiments]]). Every customer is folded into their linked-account GROUP ([[../tables/customer_links]] `group_id`) so one real person's several accounts contribute ONE net-revenue number to ONE arm. The arm for a group is read through the harness SDK `listAssignments` — never a raw `.from` on the experiment tables (CLAUDE.md raw-`.from` STOP rule, `scripts/_check-subscriber-experiments-sdk-compliance.ts`). A group with no `customer_links` rows is an unlinked singleton whose `group_id` doubles as its customer id (the harness `resolveGroupId` fallback).

## Measurement window — per-group, anchored on `assigned_at`

Each group's window is `[assigned_at, assigned_at + windowDays)` (default `DEFAULT_WINDOW_DAYS = 90`), capped at `asOf`. A group assigned last week and one assigned two months ago are each measured over their OWN 90 days — never a shared calendar window — because the pre-registered metric is 90-day exposure from sticky first-eligibility. A group whose window hasn't closed yet still contributes its partial in-window revenue; gating on the window having actually closed for the registered sample is the Phase 3 verdict engine's job, not this module's.

## Secondary metrics (per arm, same per-group window)

| Metric | Source | Rule |
|---|---|---|
| `voluntaryCancelRate` | [[../tables/customer_events]] `event_type ∈ (subscription.cancelled, portal.subscription.cancelled)` | fraction of groups with ≥1 cancel event in-window |
| `skipRate` | M1 next-order journey — [[../tables/journey_step_events]] `step_key='lifecycle'`, `response_value='skipped'` | fraction of groups that skipped a next order in-window |
| `swapAddOnRate` | same journey events, `response_label` containing `swap`/`add` | fraction of groups that swapped or added an item in-window |
| `distinctProductsPerCustomer` | distinct `variant_id`/`product_id`/`title` across in-window [[../tables/orders]] `line_items` | mean distinct products ordered per group |

Journey events are keyed by session, so the module resolves session → customer first via [[../tables/journey_sessions]] `customer_id`, then folds each event into its group's window.

## Exports

| Export | Signature | What |
|---|---|---|
| `computeExperimentMetrics(workspaceId, slug, opts?)` | `Promise<ExperimentMetrics>` | the one entry point — per-arm rollup. `opts`: `{ windowDays?, asOf?, admin? }`. Zeroed arms when no assignments exist. |
| `ExperimentMetrics` / `ArmMetrics` / `GroupNetRevenue` | type | per-experiment + per-arm shapes (`treatment` + `holdout`). `ArmMetrics.netRevenueVarianceCents2` is the SAMPLE variance (÷ n−1) of per-person net merchandise revenue — the dispersion the verdict's Welch t-test needs (0 when n < 2). `ExperimentMetrics.perGroupNet` is the per-person-group net revenue list (`GroupNetRevenue` = `{ groupId, arm, netRevenueCents }`) — the grain the matured-window guardrail ([[reminder-results-sdk]] `computeMaturedArmRevenue` → [[subscriber-experiment-guardrails]] `isRevenueWindowMatured`) filters to groups whose reminded renewal has settled. |
| `welchTwoSampleCI(meanT, varT, nT, meanH, varH, nH, alpha)` | `WelchResult` | PURE two-sample **Welch's t-test** + confidence interval on a difference of means (unequal variances). Returns `{ diffCents, lowCents, highCents, df, significant }`; `significant` ⇔ the interval excludes 0. Needs ≥2/arm. Used by the verdict engine ([[subscriber-experiment-guardrails]] `evaluateVerdict`) + the results lens ([[reminder-results-sdk]] `deriveVerdict`). |
| `studentTQuantile(p, df)` | `number` | t-quantile via the Cornish-Fisher expansion of `invNorm` — no stats dependency; → z for large df. |
| `DEFAULT_WINDOW_DAYS` | `const 90` | the pre-registered horizon. |
| `NETTED_REFUND_STATUSES` | `const ['succeeded','settled']` | the only refund statuses netted out. |

## Pure measurement — no writes

This module performs NO writes. It reads orders, order_refunds, customer_links, customer_events, journey_sessions, journey_step_events directly (none are SDK-chokepoint tables) and reads the experiment + assignments ONLY through the [[subscriber-experiments]] SDK (`getExperiment` + `listAssignments`). All `.in(...)` filters are chunked (`IN_CHUNK = 500`) so a large arm never builds an unbounded IN list.

## Status / open work

- ✅ Phase 1 — this module (per-arm net-revenue + secondary-metric rollup).
- ✅ Phase 2/3 — guardrail evaluator + scheduled verdict engine shipped as [[../inngest/subscriber-experiment-guardrails]] (`subscriber-experiment-guardrail-cron`, retention-owned `MONITORED_LOOPS`, `emitCronHeartbeat`), logic in [[subscriber-experiment-guardrails]].

## Net MERCHANDISE revenue (launch-readiness Phase 3)

The primary metric is 90-day **net merchandise** revenue per person — item revenue after discounts, EXCLUDING tax + shipping, and only from PAID orders (CEO requirement, 2026-11-17). Two pure exports do this:

- `netMerchandiseCents(order)` — sums the product `line_items` (`price_cents` or `unit_cents` × `quantity` − `total_discount_cents`), dropping Shipping-Protection lines. `orders.total_cents` is NOT used (it bundles `avalara_total_tax_cents` + shipping + SP). Renewal `payment_details` is null, so line_items is the source.
- `isPaidOrder(order)` — only `paid` / `partially_refunded` count (mixed-case `financial_status`); pending/authorized/voided/fully-refunded excluded.

`computeExperimentMetrics` now charges `netMerchandiseCents` over paid orders only, then nets settled refunds as before.
