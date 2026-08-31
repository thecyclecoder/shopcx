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
- **Internal (SHOPCX*) orders verify headroom locally, not via Shopify.** An order that never existed in Shopify returns `{ok:false, reason:'no_shopify_order_id'}` BEFORE any Shopify call — a structural fact about the order, not a transient failure. The return-creation path ([[shopify-returns]] `readReturnCreationRefundLedger`) branches on that specific reason and computes a real ceiling from `orders.total_cents` minus the mirror's terminal refunds via `deriveInternalRefundCeilingCents`, so an internal-order return is verified rather than refused. Every OTHER `ok:false` reason (`shopify_call_failed` / `order_not_found` / `invalid_input`) still surfaces as `refundableCents=null` so the caller's refuse-never-assume branch fires — a Shopify outage must not be downgraded into a local guess. Phase 1 of [[../specs/internal-order-returns-blocked-by-refund-headroom-guard]].

## Callers

- **`get_order_refund_ledger`** — Sonnet data tool on [[sonnet-orchestrator-v2]] (alongside `get_returns` / `get_payment_methods`). Takes `order_number`, resolves it to `orders.id` scoped by workspace + linked-customer ids, then formats the ledger for the model. Documented in [[../orchestrator-tools]].
- **`loadCsDirectorCallBrief`** (`scripts/builder-worker.ts` → `runCsDirectorCallJob`). For each recent Shopify order on the escalated ticket's customer (up to 5), the brief renders one `charged / refunded / REFUNDABLE / OUT-OF-BAND` line so June rules on the real refundable balance instead of hitting a rail.
- **[[cx-agent-sdk]] `getOrderRemedyState`** — the mandatory pre-money-remedy read consumed by the CS director + the money-remedy guard + the founder escalation card. Phase 1 of [[../specs/remedy-state-must-see-out-of-band-refunds]] routes its `refunds_succeeded_cents` + `remaining_refundable_cents` through this ledger (not the mirror alone), and surfaces `out_of_band_refunds_cents` + `headroom_confidence` so a caller can tell mirrored from unmirrored money and refuse on a degraded read. Derived-from ticket dac9f0c7 (yvette jong, 2026-08-24): SC126000 had $65.28 total, $5.32 mirrored, and a $59.96 out-of-band Shopify refund — the mirror-only reader would have authorized a double refund.

## See also

- [[../tables/order_refunds]] — the local mirror this library reconciles against.
- [[refund]] `refundOrder` — the money-moving chokepoint; the caller that WRITES `order_refunds`.
- [[shopify-order-actions]] `findPendingRefundTxn` — the pending-refund detector this library reuses.
- [[shopify-sync]] `getShopifyCredentials` · [[shopify]] `SHOPIFY_API_VERSION` — the Shopify REST auth + version pin.
