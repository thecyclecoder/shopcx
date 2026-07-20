# libraries/refund-ledger

Live refundable-balance read for a Shopify order. Answers the single question that dissolves the SC133086 escalation class: **what is ACTUALLY still refundable on this order right now, per the gateway?**

**File:** `src/lib/refund-ledger.ts`

## Why it exists

A customer ticket on 2026-07-20 burned a Sol first-touch, a June review, AND a founder ruling for one reason: no agent could see a refund that was issued directly in the Shopify admin. An $89.42 pricing-correction refund on order SC133086 never mirrored into [[../tables/order_refunds]], so the returns tool reported $229.26 still owed while the order itself read as partially refunded. Our local mirror is only ever written when [[refund]] `refundOrder` fires — an out-of-band refund is invisible to it and makes the balance math lie. Shopify's transaction ledger is the source of truth; this library is the one place that reads it.

## Exports

### `getOrderRefundLedger` — function

```ts
async function getOrderRefundLedger(
  workspaceId: string,
  orderId: string,
): Promise<OrderRefundLedger>
```

- `orderId` is the INTERNAL `orders.id` UUID (CLAUDE.md hard rule: internal joins use UUIDs, never `shopify_*_id`).
- Resolves the order scoped to `workspace_id`, then reads `GET /admin/api/{SHOPIFY_API_VERSION}/orders/{shopify_order_id}/transactions.json` via [[shopify-sync]] `getShopifyCredentials` + [[shopify]] `SHOPIFY_API_VERSION`.
- Returns a typed miss (`{ ok: false, reason }`) for missing order / no `shopify_order_id` / failed Shopify call. **Never throws.**

### `computeRefundLedger` — function (pure)

```ts
function computeRefundLedger(
  transactions: ShopifyTxnLite[] | null | undefined,
  mirror: { amount_cents: number }[] | null | undefined,
): { saleCents; refundedCents; pendingCents; refundableCents; outOfBandCents; refunds }
```

Pure computation extracted for unit-testing without hitting the network. Reconciliation is a greedy amount-match — each Shopify refund is matched against at most one still-unconsumed mirror row of the same `amount_cents`; a refund with no match is out-of-band.

## Return shape

```ts
{
  ok: true,
  saleCents: number,        // sum of successful sale + capture transactions
  refundedCents: number,    // sum of successful refund transactions
  pendingCents: number,     // sum of pending refund transactions (PayPal etc. settling)
  refundableCents: number,  // max(0, sale − refunded − pending) — the CEILING for a new refund
  outOfBandCents: number,   // sum of settled Shopify refunds NOT present in order_refunds
  refunds: [{
    amountCents,
    gateway,
    processedAt,
    status,                 // 'success' | 'pending' | 'failure' | 'error' | 'other'
    mirroredLocally,        // true when a public.order_refunds row matches on amount
  }],
}
```

### Contract highlights

- **`refundableCents` is the ceiling.** Every refund path (Sol, June, self-heal) must clamp against it. A pending refund is subtracted from headroom so an in-flight PayPal settlement is not double-counted (same signal [[shopify-order-actions]] `findPendingRefundTxn` already surfaces to `partialRefundByAmount`).
- **`outOfBandCents > 0` means someone refunded outside ShopCX** (a manual refund in the Shopify admin, an Appstle-side refund, etc.). This is the exact field that would have resolved SC133086 at first touch.
- **STRICTLY READ-ONLY.** Never mutates. Never fires a refund. It performs no writes.

## Callers

Phase 1 has no callers yet — this ships the primitive. Phase 2 (see the spec) wires it as:
- a `get_order_refund_ledger` data tool on [[sonnet-orchestrator-v2]] (alongside `get_returns` / `get_payment_methods`),
- an order-scoped ledger summary in the cs-director brief built by `scripts/builder-worker.ts` `runCsDirectorCallJob`.

## See also

- [[../tables/order_refunds]] — the local mirror this library reconciles against.
- [[refund]] `refundOrder` — the money-moving chokepoint; the caller that WRITES `order_refunds`.
- [[shopify-order-actions]] `findPendingRefundTxn` — the pending-refund detector this library reuses.
- [[shopify-sync]] `getShopifyCredentials` · [[shopify]] `SHOPIFY_API_VERSION` — the Shopify REST auth + version pin.
