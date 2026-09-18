# libraries/refund

Gateway-aware refund dispatcher — the ONE money-moving refund chokepoint in the codebase.

**File:** `src/lib/refund.ts`

## Why it exists

Every refund path in the codebase (returns Inngest `issue-refund`, 30-day playbook downstream, AI `partial_refund` + `redeem_points_as_refund`, ticket-detail Improve tab, manual return-refund route, fraud-case `cancel_refund_orders`) resolves to `refundOrder`. It reads the order's gateway and routes the mutation — a Shopify refund mutation can never fire on a Braintree-paid internal order (defect #1 in [[../reference/commerce-sdk-inventory]]). Its callers write; nothing else in the codebase touches a refund mutation. `refundBraintreeTransaction` is called from ONE file (`src/lib/refund.ts`) — enforced by [[shopify-order-actions]]'s scoping of Shopify-side refund REST + `refundCreate` to itself.

## Exports

### `refundOrder` — function

```ts
async function refundOrder(
  workspaceId: string,
  orderId: string,
  amountCents: number,
  reason: string,
  opts?: RefundOrderOptions,
): Promise<RefundOrderResult>
```

The single refund entry point. Reads the order scoped to `workspace_id`, dispatches on gateway (see [[../lifecycles/return-pipeline]] § Files touched), and on success writes:
1. **[[../tables/order_refunds]]** — the mirror row keyed on `(order_id, request_key)` (write-on-fire; the pre-dispatch guard reads back the same key to short-circuit a same-shape retry).
2. **`orders.financial_status`** — derive-and-set from the mirror ledger (see § Writer contract for `orders.financial_status` below).
3. **[[../tables/returns]] `refunded_at`** — any open return on this order (double-refund guard, SC132396).
4. **[[../tables/customer_events]]** — an `order.refunded` event so the timeline shows the movement.

Every post-success write is best-effort: money already moved, so a bookkeeping failure logs and returns success. The Phase-3 T+3d [[../inngest/refund-settlement-reconcile]] catches any that missed.

### `resolveRefundMethod` — function

Read-only branch preview — same rule as `refundOrder`, no external API calls. Used by `scripts/_probe-refund-order.ts` and audit tools that ask "which gateway would this order refund through?" without moving money.

### `hashRefundRequestKey` / `hashActionRefundKey` — functions

Stable idempotency-key helpers over `(order_id, amount, reason)` and `(actor_scope, actor_id, order_id, amount, reason)` respectively. Callers that carry an action-side request id thread it via `opts.requestKey` so Inngest step retries and self-heal re-drives short-circuit against the same key; `hashActionRefundKey` scopes to the ACTION (ticket / returns row / replacement) so two legitimate refunds of the same amount + reason on the same order get distinct keys.

## Writer contract for `orders.financial_status`

**`refundOrder` writes `orders.financial_status` on success — engine-independent.** Before this write existed, only the Shopify sync ([[shopify-sync]] / [[shopify-webhooks]] `handleOrderEvent`) touched the column, so every in-house internal order that was refunded still read as paid on the order row while its refund ledger and money movement were fine. See [[../specs/a-refunded-order-must-say-it-was-refunded]].

The value is derived from the ledger, not the amount just refunded:

- Sum `amount_cents` for `[[../tables/order_refunds]]` rows with `status IN ('succeeded','settled')` on this `(workspace_id, order_id)`.
- Compare against `orders.total_cents`: reaching total ⇒ `refunded`; any positive lesser sum ⇒ `partially_refunded`.
- Two partials that together clear the total therefore end up fully refunded — never inferred from the single amount.

**Who wins on a Shopify order — the vendor.** For a Shopify order the sync is authoritative and re-writes this column from every webhook/sync landing. `refundOrder`'s write is a BACKSTOP that never regresses a stronger vendor-stamped state (weight: `refunded` > `partially_refunded` > everything else), so a later vendor value at or above the local write is preserved. If the local ledger has already reached full and the vendor still reads partial, the backstop advances it — that is the intended safety net.

**Case handling.** The column carries both `PAID`/`paid` and `REFUNDED`/`refunded` and `PARTIALLY_REFUNDED`/`partially_refunded` in prod ([[../tables/orders]] § `financial_status` gotcha) — a case-sensitive comparison already mismeasured this exact problem while it was being investigated. The comparison is case-insensitive; the write is lowercase.

**Historical correction.** Fixing the write path forward left the wall in place: measured 2026-09-18, 15 internal orders and 33 store orders under-reported on the column. `scripts/_backfill-order-financial-status.ts` closes that gap — idempotent, dry-run by default, `--apply` to write; drives off the ledger, never claims more refunded than the ledger shows, and re-runs as a no-op. Auto-ledgered in [[../tables/data_op_runs]] via [[ship-time-backfill-detector]]'s `_backfill-*.ts` convention.

## Contract highlights

- **Money moves ONCE.** The pre-dispatch guard reads `order_refunds` for a terminal row on the same `(workspace, order, request_key)` and short-circuits — combined with the `(order_id, request_key)` unique index, the post-success mirror write is idempotent under retry.
- **Dry-run probe.** `opts.dryRun = true` resolves the branch and returns `{ success:true, method, dryRun:true }` without firing any SDK call, stamping any return, or writing any event / financial_status. Used by `scripts/_verify-refund-dispatcher.ts` cohort checks and any audit tool that must not spend money.
- **Idempotency key is a stable hash.** When `opts.requestKey` is omitted, `hashRefundRequestKey(order_id, amount, reason)` is the fallback — enough for retry-with-same-shape, not enough to distinguish two legitimate refunds of the same amount + reason on the same order (callers in that case MUST pass an explicit key).

## Callers

- **[[../inngest/returns]] `issue-refund`** — the returns pipeline's money step.
- **AI `partial_refund` + `redeem_points_as_refund`** ([[action-executor]]) — Sonnet direct-action refunds.
- **Ticket-detail Improve tab** — one-click refund from the CX surface.
- **Manual return-refund route** — human-initiated refund.
- **Fraud-case `cancel_refund_orders`** — sweep refund on a fraud case close.
- **30-day playbook downstream** — refund step of the MBG flow.

## See also

- [[../tables/order_refunds]] — the local mirror this file writes on success.
- [[vendor-refund-mirror]] — the OTHER writer of that mirror (for vendor-initiated refunds we did not dispatch — Shopify admin, Appstle, etc.). Uses `request_key='shopify_refund:{id}'` to stay non-colliding with `refundOrder`'s content-hash key.
- [[refund-ledger]] — the read side: `refundableCents` ceiling from the Shopify transaction log, used before dispatch to refuse a refund that would exceed the vendor's balance.
- [[shopify-order-actions]] `partialRefundByAmount` / `recordManualRefund` — the Shopify-side helpers `refundOrder` calls.
- [[integrations__braintree]] `refundBraintreeTransaction` — the Braintree-side helper.
- [[../lifecycles/return-pipeline]] — the end-to-end lifecycle this chokepoint sits in.

---

[[../README]] · [[../../CLAUDE]]
