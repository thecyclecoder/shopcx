# libraries/storefront-ltv-proxy

Phase 1 inputs for the predicted-LTV proxy (M3, the LTV-proxy reconciler). Derives the two real-data inputs the `predicted_ltv_per_visitor` metric needs: the lifetime margin of a new subscriber, and the sub-attach rate of a cohort.

**File:** `src/lib/storefront/ltv-proxy.ts` · Spec: [[../specs/storefront-ltv-proxy-reconciler]] · Goal: [[../goals/storefront-optimizer]].

## Exports

### `estimateSubLTV({ workspaceId, product_id, audience?, marginFraction?, admin? })` → `Promise<SubLTVEstimate>`
Estimates the expected lifetime **margin** of a NEW subscriber for a product, from REALIZED subscription history. Renewal survival = mean paid orders past the initial, computed off [[../tables/orders]].`subscription_id` (the universal renewal log — covers Appstle + internal subs; [[../tables/transactions]] is Braintree-only and misses Appstle renewals). `est_sub_ltv_cents = round(margin_fraction × mean_lifetime_revenue_cents)`. Cross-checks against customer-level realized LTV (customer_links-group-aware, same semantics as [[customer-stats]] `getCustomerStatsBatch`).

**2026-07-08 — all aggregation moved into the `public.estimate_sub_ltv(p_workspace_id, p_product_id)` RPC** (migration `20260708120000`, backed by a GIN index on `subscriptions.items`). The old path paged EVERY subscription ordered by `created_at` (no supporting index → a full on-disk sort spilling ~9 MB/call → **314 GB**, 98% of all instance temp-spill — the offender [[db-health]]/Devi now attributes) and then shipped every order for every matched sub + customer to fold ~6 scalars in JS. Those big `.in()` order reads silently hit Supabase's 1000-row cap, so the shipped result was **wrong**: renewal survival undercounted ~20%, the subscriber-LTV cross-check silently returned $0. The RPC does the `subscriptions ⋈ orders` renewal/revenue rollup + the customer-links-aware LTV cross-check server-side, returning one aggregate row (both refund rules preserved verbatim); the function stays a thin wrapper that applies only the placeholder margin + flags. **29–65× faster AND correct** (verified against hand-computed ground truth). `MAX_PAGES`/`chunk` are retained for `subAttachRate`, which still pages `storefront_events`.

`SubLTVEstimate` carries `renewal_survival`, `mean_order_cents`, `mean_lifetime_revenue_cents`, `margin_fraction`, `est_sub_ltv_cents`, `sample_size`, `mean_subscriber_ltv_cents`, and `flags`.

### `subAttachRate(cohort)` → `Promise<SubAttachResult>`
Sub-attach rate = subscription conversions ÷ converting sessions, off the [[../tables/storefront_events]] `order_placed` stream joined to [[../tables/orders]] for `subscription_id` (same attribution spine as [[storefront-experiment-attribution]]). A converting session counts once (earliest order wins). `cohort` = `{ workspaceId, product_id, lander_type?, audience?, since?, until? }`. Returns `converting_sessions`, `subscription_conversions`, `sub_attach_rate`, `flags`.

### Constants
- `PLACEHOLDER_MARGIN_FRACTION = 0.6` — the flagged fallback margin used when no per-product COGS source exists.
- `MIN_SUBS_FOR_ESTIMATE = 5` — below this realized-subscriber count, `estimateSubLTV` flags `insufficient_history`.

## Gotchas
- **No hardcoded economics.** There is no per-product COGS source yet (the CFO COGS/landed-cost spine isn't built). `margin_fraction` is a PARAMETER (`opts.marginFraction`) with a placeholder default and a loud `flags.cogs_source_missing` + `console.warn` — never a silent economic truth. Phase 3's reconciler recalibrates this weight against actual 4-month cohort LTV.
- **Audience isn't segmentable yet.** Subscription history carries no audience tag, so `estimateSubLTV` echoes `audience` but degrades to product-level and raises `flags.audience_not_segmentable`. Same for `lander_type`/`audience` on `subAttachRate` (`flags.dims_not_segmentable`) — Phase 2 ties those dims via `experiment_exposure`.
- **Renewal survival from orders, not transactions.** [[../tables/transactions]] only logs the Braintree/internal-checkout flow; Appstle/Shopify renewals never write a transactions row. `orders.subscription_id` is the universal source.
- **Appstle item shape.** `itemsMatchProduct` matches `subscriptions.items[].product_id` (UUID, internal subs); Appstle subs that carry only Shopify variant ids won't match by product_id and are excluded (reflected in `sample_size`).
- **Inputs only.** This file ships the input functions. Phase 2 ([[storefront-ltv-metrics]]) composes them into `predicted_ltv_per_visitor` and persists [[../tables/storefront_ltv_metrics]]; Phase 3 builds the reconciler. `INITIAL_WEIGHTS_VERSION = 1` (the proxy-weights version stamped on every metric row until Phase 3 recalibrates) lives here.
