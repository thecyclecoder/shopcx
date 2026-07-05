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
| 2 | AI `partial_refund` direct_action | [[../../src/lib/action-executor.ts]]:1050 | `refundOrder` (from `src/lib/refund.ts`) | **dispatcher** | Phase-3 migration — resolves the internal order UUID from the AI-supplied `shopify_order_id` (or `order_number`), then calls `refundOrder` with `source: "ai"` + `customerId` + `ticket_id`. The local double-refund stamp was removed — `refundOrder` owns it now. |
| 3 | AI `redeem_points_as_refund` direct_action | [[../../src/lib/action-executor.ts]]:1095 | `refundOrder` (from `src/lib/refund.ts`) | **dispatcher** | Phase-3 migration — loyalty-points redemption issues the partial refund through `refundOrder` with `eventProperties: { loyalty_tier, points_spent }`. |
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

## Related

[[../lifecycles/return-pipeline]] · [[../lifecycles/chargeback-pipeline]] · [[../libraries/shopify-order-actions]] · [[../libraries/action-executor]] · [[../libraries/playbook-executor]] · [[../inngest/returns]] · [[../integrations/braintree]] · [[../operational-rules]]
