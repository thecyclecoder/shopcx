# Commerce SDK inventory

Reference doc tracking every commerce mutation surface in the codebase — refunds, cancels, credits — with a per-call-site classification against the gateway-aware helper set. Populated in phases against the spec **[[../specs/returns-refund-internal-aware-dispatcher]]** (parent goal milestone M1 — stop the two critical money bugs).

The goal: nothing outside the sanctioned SDK boundary can quietly hit a Braintree-paid ("internal", SHOPCX*) order with a raw Shopify refund mutation that reports success while no money actually moves. Post-Phase-3, every entry point below routes through `src/lib/refund.ts` `refundOrder()`. The two Shopify refund primitives (`partialRefundByAmount`, Shopify REST refund POST) live inside `src/lib/shopify-order-actions.ts`; `refundBraintreeTransaction` lives inside `src/lib/integrations/braintree.ts` and is called from exactly one caller (`src/lib/refund.ts`).

## Defect register — refund entry points

Each row is one call site that can issue an order refund. Classification legend:

- **dispatcher** — the call site routes through `src/lib/refund.ts` `refundOrder()`. This is the target state; gateway routing (Shopify vs Braintree) and the double-refund guard happen inside the dispatcher.
- **indirect** — the call site delegates to a downstream flow whose refund step is separately classified (i.e. inherits the delegate's classification).
- **none** — the entry point is nominally refund-related (per the spec's list) but does not itself issue an order refund today.

Post-Phase-3, no row remains in the pre-migration **raw** class — every raw entry point migrated onto `refundOrder`.

| # | Entry point | Call site | Helper called | Classification | Notes |
|---|---|---|---|---|---|
| 1 | `returns-issue-refund` Inngest step | [[../../src/lib/inngest/returns.ts]]:186 | `refundOrder` (from `src/lib/refund.ts`) | **dispatcher** | Phase-3 migration — the reference gateway-aware branch that used to inline `refundBraintreeTransaction` + `partialRefundByAmount` collapsed onto `refundOrder`. The Inngest step now passes `ret.order_id` + `net_refund_cents` + a `source: "inngest"` opt with the `return_id` event property. |
| 2 | AI `partial_refund` direct_action | [[../../src/lib/action-executor.ts]]:1050 | `commerce/refund.issueRefund` → `refundOrder` (from `src/lib/refund.ts`) | **dispatcher** | Phase-3 migration — resolves the internal order UUID from the AI-supplied `shopify_order_id` (or `order_number`), then calls the SDK wrapper `commerce/refund.issueRefund` (Phase 2 of [[../specs/commerce-sdk-actions-create-order-create-subscription-refund-and-dollar-replacement]]) which delegates to `refundOrder` with `source: "ai"` + `customerId` + `ticket_id`. The local double-refund stamp was removed — `refundOrder` owns it now. |
| 3 | AI `redeem_points_as_refund` direct_action | [[../../src/lib/action-executor.ts]]:1095 | `commerce/refund.issueRefund` → `refundOrder` (from `src/lib/refund.ts`) | **dispatcher** | Phase-3 migration — loyalty-points redemption issues the partial refund through the SDK wrapper `commerce/refund.issueRefund` (Phase 2 of [[../specs/commerce-sdk-actions-create-order-create-subscription-refund-and-dollar-replacement]]) with `eventProperties: { loyalty_tier, points_spent }`. |
| 4 | 30-day playbook `confirm_return` | [[../../src/lib/playbook-executor.ts]]:3260 | `createFullReturn` → downstream `returns-issue-refund` step (row 1) | **indirect** | Unchanged — the 30-day flow inserts a return row via [[../libraries/shopify-returns]] `createFullReturn` and the refund itself fires later from row 1's Inngest step, which is now `dispatcher`-classified. Regression 2026-06-08 fix (createFullReturn instead of bare `pending_label`) is preserved. |
| 5 | Ticket-detail Improve tab "Refund" action | [[../../src/app/api/tickets/[id]/order-actions/route.ts]] | `refundOrder` (from `src/lib/refund.ts`) | **dispatcher** | Phase-3 migration — the route now resolves `orders.id` + `orders.total_cents` from the UI-supplied `shopify_order_id`, then calls `refundOrder(...)` with `source: "agent"`, computing `amountCents` from `full: true` (total_cents) or explicit `amount_cents`. Line-item-scoped refunds are rejected — callers must resolve the sum first. The Shopify-only `refundOrder` wrapper in shopify-order-actions.ts was deleted. |
| 6 | Manual return-refund route (agent UI) | [[../../src/app/api/workspaces/[id]/returns/[returnId]/refund/route.ts]] | `refundOrder` (from `src/lib/refund.ts`) | **dispatcher** | Phase-3 migration — the `method="shopify_refund"` path reads `returns.net_refund_cents` + `returns.order_id` and dispatches through `refundOrder` with `source: "agent"`. `closeReturn` still runs cosmetically to close the Shopify-side return record. Idempotent — refuses to double-refund a return that already carries `refunded_at`. |
| 7 | Fraud-case `cancel_refund_orders` step | [[../../src/app/api/workspaces/[id]/fraud-cases/[caseId]/confirm-fraud/route.ts]] | `refundOrder` (from `src/lib/refund.ts`) + `cancelOrder(refund: false)` | **dispatcher** | Phase-3 migration — the step now calls `refundOrder(workspace, orders.id, total_cents, "Fraud offset")` FIRST (source: "fraud", fraud_case_id in properties), then `cancelOrder(..., { refund: false })` on Shopify orders so Shopify doesn't try to double-refund. Internal (SHOPCX*) orders in a fraud batch — which previously failed with "Order not found" for lacking a `shopify_order_id` — now refund via Braintree. |
| 8 | Chargeback lifecycle routes | [[../../src/app/api/chargebacks/]] | — | **none** | Unchanged — the chargeback lifecycle cancels subscriptions via [[../integrations/appstle]] and records `chargeback_subscription_actions` rows; it does not issue an order refund today. Any future "offset the dispute" flow adds MUST route through `refundOrder`. |

## Helper library shape (post-Phase-3)

| Helper | File | Role | Called from |
|---|---|---|---|
| `refundOrder(workspaceId, orderId, amountCents, reason, opts)` | [[../../src/lib/refund.ts]] | **The dispatcher.** The single gateway-aware refund entry point. Reads the order, routes internal orders to `refundBraintreeTransaction`, Shopify orders to `partialRefundByAmount` (which returns `needsBraintreeFallback` for Shopify-side Braintree orders, at which point the dispatcher itself does `refundBraintreeTransaction` + `recordManualRefund`). Stamps `refunded_at` on open returns for the order (double-refund guard). Logs `order.refunded` on `customer_events`. | Every entry point in the Defect register above. |
| `resolveRefundMethod(workspaceId, orderId)` | [[../../src/lib/refund.ts]] | Read-only branch preview — reads `orders` and returns the resolved method without firing any SDK call. | `scripts/_probe-refund-order.ts`. |
| `partialRefundByAmount(workspaceId, shopifyOrderId, amountCents, reason?)` | [[../../src/lib/shopify-order-actions.ts]] | **Internal** — Shopify REST refund POST. Probes the Shopify sale transaction; healthy gateway → fires the refund; Braintree gateway → returns `{ needsBraintreeFallback: true, braintreeTxnId }` so the dispatcher handles the Braintree side. Never calls `refundBraintreeTransaction` itself. | `refundOrder` (via `src/lib/refund.ts`). |
| `recordManualRefund(workspaceId, shopifyOrderId, amountCents, note?)` | [[../../src/lib/shopify-order-actions.ts]] | **Internal** — records a refund on the Shopify order without moving money (used after `refundBraintreeTransaction` succeeds, to reflect the refund on the Shopify order for bookkeeping). | `refundOrder` (via `src/lib/refund.ts`). |
| `refundBraintreeTransaction(workspaceId, txnId, amountCents)` | [[../../src/lib/integrations/braintree.ts]] | Braintree API refund. | `refundOrder` (via `src/lib/refund.ts`) — the ONLY caller outside the definition file. |
| `cancelOrder(workspaceId, shopifyOrderId, { refund, restock, notify })` | [[../../src/lib/shopify-order-actions.ts]] | Shopify `orderCancel`. Callers pass `refund: false` post-Phase-3 — the refund goes through `refundOrder` separately. | ticket-detail order-actions route (cancel action), fraud-case confirm route (with `refund: false`). |
| `processReturn(workspaceId, returnId)` | [[../../src/lib/shopify-returns.ts]] | Shopify `returnProcess` mutation — still available for callers that want to close a Shopify-side return record via the returnProcess flow, but no longer wired into the manual return-refund route (which uses `refundOrder`). | (no live caller post-Phase-3). |

## Grep verification (post-Phase-3)

Matching the verification bullets in [[../specs/returns-refund-internal-aware-dispatcher]] § Phase 3:

- `grep -rn 'refundCreate\|refund_v2' src/` — **zero matches.** The raw `refundOrder` GraphQL wrapper in `shopify-order-actions.ts` (the sole in-repo caller of `refundCreate`) was retired during Phase 3. The verification says "matches only inside `src/lib/shopify-order-actions.ts`"; the trivial empty set satisfies that.
- `grep -rn 'refundBraintreeTransaction' src/` — matches at [[../../src/lib/integrations/braintree.ts]] (definition) and [[../../src/lib/refund.ts]] (import + 2 call sites + doc mentions). The only caller outside the definition file is `src/lib/refund.ts`, matching the verification bullet exactly. `shopify-order-actions.ts` no longer imports it (`refundOrderViaBraintree` was retired). `inngest/returns.ts` no longer imports it (the branch collapsed onto `refundOrder`).

## Phase-3 migration record

Every enumerated entry point migrated onto `refundOrder`:

- Retired functions in `shopify-order-actions.ts`: the raw `refundOrder(...)` GraphQL wrapper (line-item / full refund via `refundCreate`) and `refundOrderViaBraintree` (Shopify-side Braintree fallback). Their responsibilities moved: the Shopify-side Braintree fallback moved into `src/lib/refund.ts` (fired by the `needsBraintreeFallback` signal that `partialRefundByAmount` now returns for Braintree-gateway Shopify orders); the raw `refundOrder` has no successor — line-item scoped refunds must now resolve to an amount and call `refundOrder` from `src/lib/refund.ts`.
- Retired call sites: the ticket-detail order-actions route no longer imports from `shopify-order-actions` for refunds; the returns Inngest no longer dynamic-imports `refundBraintreeTransaction`; the fraud-case route no longer passes `refund: true` to `cancelOrder`; the manual return-refund route no longer calls `processReturn` for `method="shopify_refund"`.
- New surfaces: `src/lib/refund.ts` `refundOrder` (dispatcher) + `resolveRefundMethod` (read-only preview). `scripts/_probe-refund-order.ts` (Phase 2 dry-run probe).

## Phase-4 regression probe

`refundOrder` gained a `dryRun` opt (`RefundOrderOptions.dryRun`) that runs the order-lookup + branch resolution, then returns `{ success: true, method, dryRun: true }` with ZERO SDK calls, no returns-table stamp, and no `customer_events` write. When `dryRun: true`, callers pass `amountCents: 0` — the positive-amount guard is bypassed because the probe never spends money.

`scripts/_verify-refund-dispatcher.ts` uses `dryRun` to answer both Phase-4 verification bullets against a real workspace:

1. **Cohort routing.** Sample N Shopify-paid + N Braintree-paid orders (most recent), call `refundOrder(..., 0, { dryRun: true })` on each, assert the resolved `method` matches the order's gateway. Any mismatch → exit 1.
2. **Double-refund guard preservation.** Read recent `customer_events` where `event_type = 'order.refunded'` (source: this dispatcher), for each check whether any `returns` row exists for the same order — if so, assert `refunded_at IS NOT NULL` (proof that the success-path stamp fired). If the dispatcher hasn't been exercised yet in the window, the guard section is skipped with a warning (not a failure — nothing to falsify against).

Usage: `npx tsx scripts/_verify-refund-dispatcher.ts <workspaceId> [--samples=N] [--guard-days=N] [--verbose]`. Exit 0 = all cohorts routed correctly + guard preserved.

## Dashboard-commerce SDK migration — Phase 1 enumeration

Spec [[../specs/commerce-sdk-migrate-dashboard-agent-ai]] (parent goal milestone M4 — Migrate internal surfaces). Phase 1 moves the eight dashboard commerce page groups — subscription / order / return / replacement / loyalty / chargeback / fraud / crisis — onto `commerce/*` Display + Mutation ops so raw `.from("subscriptions"|"orders"|…)` reads and per-page pricing enrichment retire, and the three verification-required behavior additions land in the same phase: Apply-Coupon UI trigger on subscription detail, Crisis "Resolve" executes its promised subscription side-effects, and fraud confirm-fraud gains compare-and-set idempotency across its multi-step wizard. The dashboard pages themselves are client components; the raw `.from()` reads live in the per-surface API routes under `src/app/api/…`. Full HTML companion table: [[commerce-sdk-inventory.html]] § 1 Surface map → Dashboard commerce pages.

**Reads → Display ops**

| # | Surface | Current raw fetch (file:line) | SDK Display op | Notes |
|---|---|---|---|---|
| D1 | Subscriptions list | `src/app/api/workspaces/[id]/subscriptions/route.ts:30,55,111` (`.from("subscriptions"|"dunning_cycles")`) | `commerce/subscription.listSubscriptions` | Fixes the silent 1000-row cap on the product-filter branch (line 54–56 fetches with no `range/limit`). Recovery status + MRR annotation stays route-side. |
| D2 | Subscription detail | `src/app/api/workspaces/[id]/subscriptions/[subId]/route.ts:28,45,53,62,71` | `commerce/subscription.getSubscription` + `commerce/order.listOrders({ subscription_id })` | Dunning + payment-failures + activity-events stay route-side. |
| D3 | Orders list (+ Amplifier SLA + counts mode) | `src/app/api/workspaces/[id]/orders/route.ts:77,105,139,191` | `commerce/order.listOrders` (with new filter surface for Amplifier chips) + `commerce/order.orderCounts` | **Phase 1 SDK ADD** — `OrderListFilters` today only accepts `financial_status`/`fulfillment_status`/`order_type`; needs `tags` / Amplifier-status fields for the dashboard chips. |
| D4 | Order detail | `src/app/api/workspaces/[id]/orders/[orderId]/route.ts:21,52,124,129,183,336,397` | `commerce/order.getOrder` + `commerce/subscription.getSubscription` + `commerce/replacement.listReplacements({ order_id })` | Storefront-attribution reads stay route-side. |
| D5 | Returns list | `src/app/api/workspaces/[id]/returns/route.ts:31,60,69` | `commerce/return.listReturns` | Existing SDK op cursor-paginates past 1000. |
| D6 | Return detail | `src/app/api/workspaces/[id]/returns/[returnId]/route.ts:19,86` | `commerce/return.getReturn` | — |
| D7 | Replacements list | `src/app/api/workspaces/[id]/replacements/route.ts:30,81,105` | `commerce/replacement.listReplacements` | — |
| D8 | Replacement detail | `src/app/api/workspaces/[id]/replacements/[replacementId]/route.ts:19,55,83,159` | `commerce/replacement.getReplacement` + `commerce/subscription.getSubscription` | — |
| D9 | Chargebacks dashboard | `src/app/api/chargebacks/route.ts:26,55,72,82,111` + `/api/chargebacks/[id]/subscriptions:24,35,42,56` | `commerce/chargeback.listChargebacks` + `commerce/subscription.listSubscriptionsByCustomer` | — |
| D10 | Fraud cases list | `src/app/api/workspaces/[id]/fraud-cases/route.ts:37,68,79,87` | `commerce/fraud.listFraudCases` + `commerce/order.getOrder` (per-case enrichment) | **Phase 1 SDK ADD** — today only `getFraudPosture` (customer-scoped) exists. |
| D11 | Fraud case detail | `src/app/api/workspaces/[id]/fraud-cases/[caseId]/route.ts:34,46,53,114,173` | `commerce/fraud.getFraudCase` (workspace + caseId scoped) | **Phase 1 SDK ADD**. |
| D12 | Loyalty members list | `src/app/api/loyalty/members/route.ts:33,44,48` | `commerce/loyalty.listLoyaltyMembers` | **Phase 1 SDK ADD** — today only `getLoyaltyBalance` (customer-scoped) + `listLoyaltyLedger` exist. |
| D13 | Loyalty member detail | `src/app/dashboard/loyalty/[memberId]/page.tsx` → `/api/loyalty/balance` + `/api/loyalty/redemptions` | `commerce/loyalty.getLoyaltyBalance` + `commerce/loyalty.listLoyaltyLedger` | Existing SDK ops. |
| D14 | Crisis events list | `src/app/api/workspaces/[id]/crisis/route.ts:33,56` | `commerce/crisis.listCrisisEvents` | **Phase 1 SDK ADD** — today only `getCrisisContext` (per-customer) exists. |
| D15 | Crisis event detail | `src/app/api/workspaces/[id]/crisis/[crisisId]/route.ts:31,43,92` — line 92 walks all active/paused subs cursor-paginated (500-row batches) | `commerce/crisis.getCrisisEvent` + `commerce/subscription.listSubscriptions({ status_in:['active','paused'] })` | **Phase 1 SDK ADD** for `getCrisisEvent`. |

**Mutations → Mutation ops**

| # | Action | Current dispatcher (file:line) | SDK Mutation op | Notes |
|---|---|---|---|---|
| DM1 | Subscription pause/resume/cancel | `src/app/api/workspaces/[id]/subscriptions/[subId]/route.ts:152,157,163` → `appstleSubscriptionAction` | `commerce/subscription.subscriptionAction(id, "pause"|"resume"|"cancel")` | — |
| DM2 | Subscription skip-next-order | `src/app/api/workspaces/[id]/subscriptions/[subId]/route.ts:168` → `appstleSkipUpcomingOrder` | `commerce/subscription.subscriptionSkipNextOrder` | — |
| DM3 | Subscription change-frequency | `src/app/api/workspaces/[id]/subscriptions/[subId]/route.ts:175` → `appstleUpdateBillingInterval` | `commerce/subscription.subscriptionUpdateBillingInterval` | — |
| DM4 | Subscription change-next-date | `src/app/api/workspaces/[id]/subscriptions/[subId]/route.ts:191` (direct `.from("subscriptions").update()`) | `commerce/subscription.subscriptionUpdateNextBillingDate` | Today writes `next_billing_date` raw — must route through the SDK dispatcher so internal + Appstle subs stay coherent. |
| DM5 | Subscription add/remove/change-qty/swap-variant | `src/app/api/workspaces/[id]/subscriptions/[subId]/items/route.ts:32,70,112` → `subAddItem`/`subRemoveItem`/`subChangeQuantity`/`subSwapVariant` | `commerce/subscription.subscriptionAddItem` / `subscriptionRemoveItem` / `subscriptionChangeQuantity` / `subscriptionSwapVariant` | — |
| DM6 | Subscription apply / remove coupon | `src/app/api/workspaces/[id]/subscriptions/[subId]/coupon/route.ts:27,64` → `subscriptionApplyCoupon` / `subscriptionRemoveCoupon` | `commerce/subscription.applyCoupon` / `commerce/subscription.removeCoupon` | SDK re-exports the internal-aware dispatcher already in `subscription-items.ts` — landed in this Phase-1 enumeration commit. |
| DM7 **Phase 1 ADD** | Apply-Coupon UI trigger on subscription detail | *(not exposed)* — `src/app/dashboard/subscriptions/[id]/page.tsx:662–697` only exposes the Remove button; POST endpoint already exists at `coupon/route.ts:8` | `commerce/subscription.applyCoupon` (via the existing coupon POST route) | Verification bullet #4 — this commit adds the input + Apply button. |
| DM8 | Subscription bill-now / payment-update email | `bill-now/route.ts:19+` → `orderNowByContract`; `payment-update/route.ts:25` → `appstleSendPaymentUpdateEmail` | `commerce/subscription.subscriptionOrderNow` / `commerce/subscription.subscriptionSendPaymentUpdateEmail` | — |
| DM9 | Chargeback reinstate (resume subscription) | `src/app/api/chargebacks/[id]/reinstate/route.ts:59` → `appstleSubscriptionAction("resume")` | `commerce/subscription.subscriptionAction(id, "resume")` | — |
| DM10 | Chargeback cancel-subscription | `src/app/api/chargebacks/[id]/cancel-subscription/route.ts:69` → `appstleSubscriptionAction("cancel", "chargeback")` | `commerce/subscription.subscriptionAction(id, "cancel", reason, "chargeback")` | — |
| DM11 | Fraud confirm-fraud — cancel-subscriptions step | `src/app/api/workspaces/[id]/fraud-cases/[caseId]/confirm-fraud/route.ts:110` → `appstleSubscriptionAction("cancel", "fraud")` | `commerce/subscription.subscriptionAction(id, "cancel", "fraud", "Fraud Detection")` | Already filters `status in ("active","paused")` at line 107 — compare-and-set is inherent; SDK migration is the swap. |
| DM12 | Fraud confirm-fraud — cancel-refund-orders step | `confirm-fraud/route.ts:167,178` → `refundOrder` + `cancelOrder` | `commerce/refund.issueRefund` + `commerce/order.cancelOrder` (M2c mutations) | Refund op inherits the internal→Braintree / Shopify→REST dispatch behavior. |
| DM13 **Phase 1 ADD** | Fraud confirm-fraud — compound-write idempotency | *(not guarded)* — `route.ts:98–121,123–196` steps are client-driven but a mid-loop failure + step-retry today re-refunds already-refunded orders | Precheck on `cancel_refund_orders` — skip orders whose `customer_events` shows a prior fraud-case refund; skip `cancel_subscriptions` subs already terminally cancelled | Verification bullet #6. |
| DM14 | Fraud cancel-subscription (single, from case detail) | `src/app/api/workspaces/[id]/fraud-cases/[caseId]/cancel-subscription/route.ts:61` → `appstleSubscriptionAction("cancel", "fraud")` | `commerce/subscription.subscriptionAction(id, "cancel", "fraud", displayName)` | — |
| DM15 **Phase 1 ADD** | Crisis "Resolve" — execute promised subscription side-effects | *(stub)* — `src/app/api/workspaces/[id]/crisis/[crisisId]/route.ts:239–252` only writes `crisis_events.status="resolved"` | `commerce/subscription.subscriptionAction(id, "resume")` for every paused `crisis_customer_actions` row + `commerce/subscription.subscriptionAddItem` for every row with `removed_item_at IS NOT NULL AND auto_readd = true` | Verification bullet #5. |
| DM16 | Loyalty redeem-points | `src/app/api/loyalty/redeem/route.ts:178` (`.from("loyalty_redemptions").insert()`) | `commerce/loyalty.redeemPoints` (M2c mutation) | Mutation op is planned in M2c; migration lands when it ships. |

## Related

[[../lifecycles/return-pipeline]] · [[../lifecycles/chargeback-pipeline]] · [[../libraries/shopify-order-actions]] · [[../libraries/action-executor]] · [[../libraries/playbook-executor]] · [[../inngest/returns]] · [[../integrations/braintree]] · [[../operational-rules]]
