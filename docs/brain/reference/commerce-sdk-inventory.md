# Commerce SDK inventory

Reference doc tracking every commerce mutation surface in the codebase — refunds, cancels, credits — with a per-call-site classification against the gateway-aware helper set. Populated in phases against the spec **[[../specs/returns-refund-internal-aware-dispatcher]]** (parent goal milestone M1 — stop the two critical money bugs).

The goal: nothing outside the sanctioned SDK boundary can quietly hit a Braintree-paid ("internal", SHOPCX*) order with a raw Shopify refund mutation that reports success while no money actually moves. Every entry point in the Defect register below is either (a) already gateway-aware today, or (b) targeted for migration onto the Phase 2 `refundOrder` wrapper (`src/lib/refund.ts`).

## Defect register — refund entry points

Each row is one call site that can issue an order refund. Classification legend:

- **gateway-aware** — the call site already routes on the order's payment gateway (Shopify vs Braintree) and cannot fire a Shopify `refundCreate` mutation against a Braintree-paid order.
- **raw** — the call site fires a Shopify-only refund/cancel mutation with no Braintree branch. This is the defect #1 vector.
- **indirect** — the call site delegates to a downstream flow whose refund step is separately classified (i.e. inherits the delegate's classification).
- **none** — the entry point is nominally refund-related (per the spec's list) but does not itself issue an order refund today.

| # | Entry point | Call site | Helper called | Classification | Notes |
|---|---|---|---|---|---|
| 1 | `returns-issue-refund` Inngest step | [[../../src/lib/inngest/returns.ts]]:186-205 | `refundBraintreeTransaction` (internal branch) · `partialRefundByAmount` (Shopify branch) | **gateway-aware** | Documented pattern per [[../lifecycles/return-pipeline]] § Phase 4. Branches on `orders.shopify_order_id`. This is the reference implementation the Phase 2 wrapper mirrors. |
| 2 | AI `partial_refund` direct_action | [[../../src/lib/action-executor.ts]]:1050-1093 | `partialRefundByAmount` | **gateway-aware** | `partialRefundByAmount` internally probes Shopify transactions and routes to `refundOrderViaBraintree` when the sale gateway is Braintree (per [[../libraries/shopify-order-actions]]). Also stamps `returns.refund_id`/`refunded_at` on any open return — the double-refund guard (Sonia Stevens SC132396). |
| 3 | AI `redeem_points_as_refund` direct_action | [[../../src/lib/action-executor.ts]]:1095-1140 | `partialRefundByAmount` | **gateway-aware** | Loyalty-points redemption issuing a partial refund against a renewal order. |
| 4 | 30-day playbook `confirm_return` | [[../../src/lib/playbook-executor.ts]]:3260 | `createFullReturn` → downstream `returns-issue-refund` step (row 1) | **indirect** | Inserts a return row via [[../libraries/shopify-returns]] `createFullReturn`; the refund itself fires later from the returns Inngest pipeline (row 1) so it inherits row 1's gateway-aware classification. Regression fix 2026-06-08 — must not silently insert a bare `pending_label` (per [[../lifecycles/return-pipeline]] § "30-day flow regression must not recur"). |
| 5 | Ticket-detail Improve tab "Refund" action | [[../../src/app/api/tickets/[id]/order-actions/route.ts]]:57-69 | `refundOrder` (Shopify-only wrapper in [[../libraries/shopify-order-actions]]:45-151) | **raw** ⚠️ | `refundOrder` uses the Shopify `refundCreate` mutation directly for `full` or `lineItems` refunds — no Braintree branch. Firing this against a Braintree-paid (SHOPCX*) order silently succeeds on the Shopify record while no money moves. **This is the defect #1 phantom-refund vector.** |
| 6 | Manual return-refund route (agent UI) | [[../../src/app/api/workspaces/[id]/returns/[returnId]/refund/route.ts]] | `processReturn` for `method="shopify_refund"` (`src/lib/shopify-returns.ts`:431-499) · `closeReturn` for `method="store_credit"` | **raw** ⚠️ | `processReturn` uses the Shopify `returnProcess` mutation and requires a `shopify_return_gid`. Internal orders have `shopify_return_gid=null` (per [[../lifecycles/return-pipeline]] § Phase 1) — the mutation cannot fire, and there is no Braintree fallback here today. |
| 7 | Fraud-case `cancel_refund_orders` step | [[../../src/app/api/workspaces/[id]/fraud-cases/[caseId]/confirm-fraud/route.ts]]:122-174 | `cancelOrder(..., { refund: true, ... })` (`src/lib/shopify-order-actions.ts`:487+) | **raw** ⚠️ | `cancelOrder` runs the Shopify `orderCancel` mutation with `refund: true`, driving a Shopify-side refund only. Not gateway-aware — an internal order in a confirmed-fraud batch will not have its Braintree charge refunded. |
| 8 | Chargeback lifecycle routes | [[../../src/app/api/chargebacks/]] (subscriptions · reinstate · cancel-subscription · settings · stats) | — | **none** | The chargeback lifecycle cancels subscriptions via [[../integrations/appstle]] and records `chargeback_subscription_actions` rows; it does not issue an order refund today (per [[../lifecycles/chargeback-pipeline]] Phase 3). If a future "offset the dispute" flow adds a refund side-effect, it must route through the Phase 2 dispatcher. |

## Helper library shape (current)

Two files host the refund primitives the entry points above resolve to:

| Helper | File | Gateway-aware? | Called from |
|---|---|---|---|
| `partialRefundByAmount(workspaceId, shopifyOrderId, amountCents, reason?)` | [[../../src/lib/shopify-order-actions.ts]]:155-406 | **yes** — probes the Shopify sale transaction, routes to `refundOrderViaBraintree` when gateway is Braintree | returns-issue-refund (Shopify branch), `partial_refund` direct_action, `redeem_points_as_refund` direct_action |
| `refundBraintreeTransaction(workspaceId, txnId, amountCents)` | [[../../src/lib/integrations/braintree.ts]]:124 | **yes** — Braintree-only by definition | returns-issue-refund (internal branch), `partialRefundByAmount` (internally via `refundOrderViaBraintree`) |
| `refundOrder(workspaceId, shopifyOrderId, { full \| lineItems, reason, notify })` | [[../../src/lib/shopify-order-actions.ts]]:45-151 | **no** — raw `refundCreate` | ticket-detail order-actions route (row 5) |
| `refundOrderViaBraintree(workspaceId, shopifyOrderId, amountCents, reason?)` | [[../../src/lib/shopify-order-actions.ts]]:407-486 | Braintree-only (internal helper of `partialRefundByAmount`) | `partialRefundByAmount` |
| `processReturn(workspaceId, returnId)` | [[../../src/lib/shopify-returns.ts]]:431-499 | **no** — Shopify `returnProcess` mutation only | manual return-refund route (row 6) |
| `cancelOrder(workspaceId, shopifyOrderId, { refund, restock, notify })` | [[../../src/lib/shopify-order-actions.ts]]:487+ | **no** — Shopify `orderCancel` (with `refund: true`) drives Shopify-side refund only | fraud-case confirm route (row 7) |

## Baseline grep expectations (Phase 1 verification)

Baseline against `main` at Phase 1 completion, matching the verification bullets in [[../specs/returns-refund-internal-aware-dispatcher]] § Phase 1:

- `grep -rn 'refundCreate' src/` — matches all live inside [[../../src/lib/shopify-order-actions.ts]] (the raw wrapper `refundOrder` at :45-151). One additional lexical match at [[../../src/lib/inngest/returns.ts]]:190 is a comment (`Shopify orders keep refundCreate.`), not a call — Phase 3's rewrite retires it when the returns branch collapses onto `src/lib/refund.ts`.
- `grep -rn 'refundBraintreeTransaction' src/` — matches at [[../../src/lib/integrations/braintree.ts]] (definition), [[../../src/lib/shopify-order-actions.ts]] (import + call in `refundOrderViaBraintree`), and [[../../src/lib/inngest/returns.ts]] (dynamic import + call in the internal branch). Matches the current caller set enumerated in [[../lifecycles/return-pipeline]] § Files touched.

## Migration target — Phase 2 dispatcher (shipped)

Phase 2 shipped `src/lib/refund.ts` — the single gateway-aware `refundOrder(workspaceId, orderId, amountCents, reason, opts)` wrapper. It mirrors the returns Inngest branch (row 1 above): read the order, dispatch by `orders.shopify_order_id` presence (absence → `refundBraintreeTransaction`; presence → `partialRefundByAmount`, which is itself gateway-aware for Shopify-side Braintree). On success it stamps `refund_id`/`refunded_at` on every open return for the order (double-refund guard, workspace-scoped, `.is("refunded_at", null)` compare-and-set — matches the SC132396 safety net) and writes an `order.refunded` row to `customer_events`. Also exports `resolveRefundMethod(workspaceId, orderId)` — a read-only branch preview used by `scripts/_probe-refund-order.ts` for the Phase 2 verification (probe two canary orders, assert `method` resolves to `shopify` and `braintree` respectively without firing any SDK call).

Phase 3 will migrate every **raw** row above (5, 6, 7) — plus the **indirect** row 4 for the goodwill/immediate-refund case — onto `refundOrder`, so no callsite outside `src/lib/refund.ts` + `src/lib/shopify-order-actions.ts` + `src/lib/integrations/braintree.ts` can ever fire a refund mutation again.

## Related

[[../lifecycles/return-pipeline]] · [[../lifecycles/chargeback-pipeline]] · [[../libraries/shopify-order-actions]] · [[../libraries/action-executor]] · [[../libraries/playbook-executor]] · [[../inngest/returns]] · [[../integrations/braintree]] · [[../operational-rules]]
