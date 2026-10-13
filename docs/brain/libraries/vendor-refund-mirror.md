# libraries/vendor-refund-mirror

The write path into [[../tables/order_refunds]] for refunds the vendor already fired — regardless of who initiated them.

**File:** `src/lib/vendor-refund-mirror.ts`

## Why this exists

[[refund]] `refundOrder` is the write-on-fire mirror for refunds ShopCX itself dispatches. A refund issued by hand in the Shopify admin (or by any path that does not call `refundOrder`) writes nothing to `order_refunds`. The double-refund guard reads that ledger before dispatch, so an incomplete ledger is not a guard — a future automated path could return the money a second time. Measured 2026-09-11: 28 of 69 fully-refunded orders under-reported, $2,429.19 unmirrored.

The Shopify `refunds/create` webhook is the primary source into this file. `handleOrderEvent`'s `financial_status` transition triggers a REST reconcile as a fallback for anything the webhook missed.

## Exports

### `parseShopifyRefundPayload` — function

```ts
function parseShopifyRefundPayload(payload) : ParsedShopifyRefund | null
```

Pure — no I/O. Sums `kind='refund'` transactions with non-failure status; returns `null` if the payload lacks an `id` or `order_id`.

### `insertShopifyRefundMirror` — function

```ts
async function insertShopifyRefundMirror(workspaceId: string, parsed: ParsedShopifyRefund) : Promise<MirrorInsertResult>
```

Idempotent on two axes:
1. **`vendor_refund_id` semantic guard** — a pre-insert lookup for `(workspace_id, order_id, vendor='shopify', vendor_refund_id)` catches a refund we already mirrored via [[refund]] `refundOrder`. Without this, `refundOrder`'s row and the webhook's row would carry different `request_key`s and both land.
2. **`(order_id, request_key)` unique index** — the DB backstop. `request_key = 'shopify_refund:${refund_id}'` is stable per refund, so a re-delivered webhook hits the constraint.

### `reconcileShopifyRefundsForOrder` — function

```ts
async function reconcileShopifyRefundsForOrder(workspaceId: string, shopifyOrderId: string) : Promise<...>
```

Fetches `/admin/api/{ver}/orders/{id}/refunds.json` and mirrors any refund the vendor has completed but the primary path missed. Called from [[shopify-webhooks]] `handleOrderEvent` when `financial_status` transitions to `refunded` / `partially_refunded`.

### `shopifyRefundRequestKey` — function

```ts
function shopifyRefundRequestKey(shopifyRefundId: string) : string
```

Returns `shopify_refund:${shopifyRefundId}`. Distinct from [[refund]] `hashRefundRequestKey` (which keys on `(order_id, amount)`) on purpose — the webhook carries the vendor's own refund id, and keying on that id is what makes a re-delivered webhook idempotent.

## Braintree refund mirroring — Phase 2

A refund issued at the Braintree payment gateway writes nothing to `order_refunds` unless `[[refund]]` dispatched it. The double-refund guard reads that ledger, so an incomplete ledger is not a guard — a future path could refund the same money twice. Measured 2026-09-24: 4 orders ($532.90) had Braintree refunds with zero ledger rows. Phase 2 mirrors these via the same reconcile pattern as Shopify.

### `braintreeRefundRequestKey` — function

```ts
function braintreeRefundRequestKey(refundId: string) : string
```

Returns `braintree_refund:${refundId}`. Distinct from the Shopify key on purpose — the Braintree gateway refund id is what makes a re-delivered webhook idempotent, same discipline as Shopify.

### `insertBraintreeRefundMirror` — function

```ts
async function insertBraintreeRefundMirror(
  workspaceId: string,
  orderId: string,
  parsed: ParsedBraintreeRefund,
  opts?: { source?: "live" | "backfill" },
): Promise<MirrorInsertResult>
```

Idempotent on two axes (same as `insertShopifyRefundMirror`):
1. **`(order_id, request_key)` unique index** — catches a re-run or re-delivered webhook.
2. **`(workspace_id, order_id, vendor='braintree', vendor_refund_id)` pre-insert lookup** — catches a refund `[[refund]]` `refundOrder` already mirrored (where `vendor_refund_id` is the gateway refund id returned by the API).

`source` defaults to `'live'` (webhook/reconcile path). `'backfill'` is for historical rows. NEVER moves money.

### `reconcileBraintreeRefundsForOrder` — function

```ts
async function reconcileBraintreeRefundsForOrder(
  workspaceId: string,
  orderId: string,
  opts?: { source?: "live" | "backfill" },
): Promise<
  | { ok: true; mirrored: number; skipped: number; status?: "refunded" | "partially_refunded" | null }
  | { ok: false; reason: string }
>
```

Fetches the order's Braintree transaction (requires `braintree_transaction_id`), reads all refunds via the gateway, mirrors any missing, and calls `[[refund]]` `deriveAndSetOrderRefundStatus` to synchronize the order status. Returns count of mirrored + skipped and the new financial_status if computed. Called on order creation and on explicit backfill.

### `extractBraintreeRefunds` — function

```ts
function extractBraintreeRefunds(
  saleTxn: any,
  refundTxns: any[] = [],
): ParsedBraintreeRefund[]
```

Pure — no I/O. Maps a sale transaction's refunds into `ParsedBraintreeRefund` objects. Accepts both inline `refunds` array (when present in SDK version) and a separate `refundTxns` array resolved from `refundIds` — de-duplicates and ignores zero/negative amounts. ⚠️ The Braintree Node SDK populates `refundIds` (id list only), not `refunds` (full objects). The amount lives on the refund TRANSACTION itself, so callers MUST fetch the refund txns by id and pass them in — reading `txn.refunds` alone yields `[]` and mirrors nothing while returning ok:true (incident 2026-09-30: 4 orders, $75.36 invisible to the guard). The parameter separation makes this function pure and unit-testable.

### `decideFinancialStatusBackfill` — function

```ts
function decideFinancialStatusBackfill(input) : BackfillGapDecision
```

Pure predicate that drives `scripts/_backfill-order-refunds-from-financial-status.ts`. Given `financial_status` + `total_cents` + the current `succeeded/settled` mirror sum, returns either the gap to write or a `skip` reason (`not_fully_refunded` | `no_total` | `already_covered` | `over_total`). Only `financial_status='refunded'` (case-insensitive) qualifies — `partially_refunded` is legitimately below its total, so it has no unambiguous gap to infer. Refuses to compute a gap that would push the ledger past `total_cents`.

### `backfillFromFinancialStatusRequestKey` — function

```ts
function backfillFromFinancialStatusRequestKey(orderId: string) : string
```

Returns `backfill:financial_status:${orderId}`. Stable per order, so a re-run of the backfill collides on the `(order_id, request_key)` unique index and is a no-op — the SC137733 idempotency proof the spec cites.

## Callers

**Shopify:**
- `src/lib/shopify-webhooks.ts` — `handleRefundCreate` webhook + the `handleOrderEvent` fallback reconcile.
- `scripts/_backfill-order-refunds-from-financial-status.ts` — Phase 2 Shopify financial_status backfill.

**Braintree (Phase 2):**
- Order creation pathway — on first load, reconcile any Braintree refunds that happened before the order was mirrored.
- `scripts/_backfill-order-refund-status-from-ledger.ts` — Phase 1 reconcile that syncs financial_status after Braintree mirroring.

## Invariants

- **Records only refunds the vendor already completed.** No `hasSuccessfulTransaction` (Shopify) ⇒ no row. Pending-only refunds are picked up when they land as a follow-up `refunds/create` with a succeeded transaction (or by the T+3d [[../inngest/refund-settlement-reconcile]]).
- **Money never moves here.** This module is ledger-only.
- **`source='live'` for the webhook + reconcile paths.** Rows this file writes on the runtime paths (`insertShopifyRefundMirror`, `insertBraintreeRefundMirror`, `reconcileShopifyRefundsForOrder`, `reconcileBraintreeRefundsForOrder`) are indistinguishable in shape from [[refund]] `refundOrder`'s own writes. `source='backfill'` rows come from the `scripts/_backfill-*.ts` scripts (see [[../specs/backfill-order-refunds-ledger-from-history]] and Phase 1 `scripts/_backfill-order-refund-status-from-ledger.ts`).
- **`status='succeeded'`.** Terminal Phase-1 state for live/backfill rows. Phase 3 T+3d reconcile ([[../inngest/refund-settlement-reconcile]]) is what flips `succeeded → settled` and catches `reversed`.
- **Backfill only from an unambiguous expected value.** `decideFinancialStatusBackfill` returns a gap ONLY on `financial_status='refunded'` — never on `partially_refunded`, where the vendor has legitimately refunded some portion and the true expected value is unknown. Every backfilled row lands with `status='settled'` (historical refund; already landed) and `vendor_refund_id=null` (the order's status is the evidence, but the specific vendor id is not derivable from the order alone).

## Gotchas

- **The unique index alone is not enough.** The DB backstop `(order_id, request_key)` catches a re-delivered webhook, but NOT a webhook echo of a refund `refundOrder` already mirrored — those carry different keys (content-hash vs `shopify_refund:` / `braintree_refund:` prefix). The pre-insert `vendor_refund_id` lookup is the semantic guard that closes that hole (both Shopify and Braintree).
- **`refunds/create` topic must be registered (Shopify).** [[shopify-webhook-register]] `WEBHOOK_TOPICS` carries it. Without registration, the primary path is silent and only the `financial_status` fallback fires — which is best-effort, since a `partially_refunded` transition doesn't always follow a partial refund.
- **Braintree SDK does NOT populate inline `refunds` array on `transaction.find()`.** It returns only `refundIds` (a list of ids); the amounts are on the refund TRANSACTIONS themselves. Reading `txn.refunds` yields `[]` and `extractBraintreeRefunds` returns nothing while the function exits ok:true — an invisible broken reconcile (2026-09-30: 4 orders, $75.36 missed). Callers MUST fetch each refund transaction by id and pass them in as the `refundTxns` parameter, or use the [[integrations__braintree]] helper that does this.

---

[[../README]] · [[refund]] · [[refund-ledger]] · [[shopify-webhooks]] · [[shopify-webhook-register]] · [[integrations__braintree]] · [[../tables/order_refunds]] · [[../inngest/refund-settlement-reconcile]] · [[../../CLAUDE]]
