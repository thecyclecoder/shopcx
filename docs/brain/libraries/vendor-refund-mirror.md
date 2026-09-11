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

Returns `shopify_refund:${shopifyRefundId}`. Distinct from [[refund]] `hashRefundRequestKey` (which keys on `(order_id, amount, reason)`) on purpose — the webhook carries the vendor's own refund id, and keying on that id is what makes a re-delivered webhook idempotent.

## Callers

- `src/lib/shopify-webhooks.ts` — `handleRefundCreate` + the `handleOrderEvent` fallback reconcile.

## Invariants

- **Records only refunds the vendor already completed.** No `hasSuccessfulTransaction` ⇒ no row. Pending-only refunds are picked up when they land as a follow-up `refunds/create` with a succeeded transaction (or by the T+3d [[../inngest/refund-settlement-reconcile]]).
- **Money never moves here.** This module is ledger-only.
- **`source='live'`** — every row this file writes counts as a live-fire mirror, indistinguishable in shape from [[refund]] `refundOrder`'s own writes. `source='backfill'` rows come from the `scripts/backfill-order-refunds-*` scripts (see [[../specs/backfill-order-refunds-ledger-from-history]]).
- **`status='succeeded'`.** Terminal Phase-1 state. Phase 3 T+3d reconcile ([[../inngest/refund-settlement-reconcile]]) is what flips `succeeded → settled` and catches `reversed`.

## Gotchas

- **The unique index alone is not enough.** The DB backstop `(order_id, request_key)` catches a re-delivered webhook, but NOT a webhook echo of a refund `refundOrder` already mirrored — those carry different keys (content-hash vs `shopify_refund:` prefix). The pre-insert `vendor_refund_id` lookup is the semantic guard that closes that hole.
- **`refunds/create` topic must be registered.** [[shopify-webhook-register]] `WEBHOOK_TOPICS` carries it. Without registration, the primary path is silent and only the `financial_status` fallback fires — which is best-effort, since a `partially_refunded` transition doesn't always follow a partial refund.

---

[[../README]] · [[refund]] · [[refund-ledger]] · [[shopify-webhooks]] · [[shopify-webhook-register]] · [[../tables/order_refunds]] · [[../inngest/refund-settlement-reconcile]] · [[../../CLAUDE]]
