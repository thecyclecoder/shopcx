# order_refunds

The refund **mirror table** — one row per authoritative refund fired against a vendor (Braintree / Shopify REST) or an internal-only accounting refund. Written on the success side of [[../libraries/refund]] `refundOrder`. Closes the Sonia Stevens SC132396 double-refund failure mode (vendor call succeeded, write-back didn't, self-heal retry re-fired the refund, customer refunded twice). See [[../specs/refund-integrity-order-refunds-mirror-verify-by-id-settlement-reconcile]] Phase 1.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `order_id` | `uuid` | — | → [[orders]].id · ON DELETE CASCADE · never the human-facing `shopify_order_id` / `order_number` |
| `request_key` | `text` | — | idempotency key · `coalesce(action.request_key, sha256(order_id + amount_cents + reason)[:32])` computed by [[../libraries/refund]] `hashRefundRequestKey` |
| `vendor` | `text` | — | CHECK ∈ `braintree` \| `shopify` \| `internal` |
| `vendor_refund_id` | `text` | ✓ | vendor's refund/transaction id — Braintree transaction id or Shopify refund id · nullable for `internal` |
| `amount_cents` | `int` | — | |
| `status` | `text` | — | CHECK ∈ `requested` \| `succeeded` \| `failed` \| `settled` \| `reversed` · Phase 1 writes `succeeded`; Phase 3 flips to `settled` |
| `requested_at` | `timestamptz` | — | default `now()` — mirror-write time (post-vendor success) |
| `settled_at` | `timestamptz` | ✓ | populated by Phase 3 T+3d reconcile |
| `created_at` / `updated_at` | `timestamptz` | — | default `now()` |

**Unique:** `(order_id, request_key)` — the DB-level double-refund guard. A retry with the same shape hits this constraint and lands in `refundOrder`'s try/catch (best-effort — the money already moved, so we log and let the Phase 3 reconcile catch drift).

**Indexes:** `(status, requested_at)` — Phase 3 cron predicate (`status='succeeded' AND requested_at < now() - '3 days'`); `(workspace_id, order_id)` — the tickets-detail refund-line lookup.

## Foreign keys

**Out:** `workspace_id` → [[workspaces]].id · `order_id` → [[orders]].id.

## Invariants

- **Written from the chokepoint only.** Every code path that fires a refund resolves to [[../libraries/refund]] `refundOrder`; the mirror row is written there and nowhere else, so no path can move money without an audit row.
- **`vendor` mirrors the dispatch decision.** Internal / Shopify-order-paid-via-dead-Braintree-gateway ⇒ `braintree`; native Shopify REST refund ⇒ `shopify`. Never inferred from the order's `financial_status`.
- **`request_key` is required and stable.** Same-shape retry ⇒ same key ⇒ the unique index short-circuits it. The default hash covers `(order_id, amount_cents, reason)` — a caller that legitimately fires two same-shape refunds MUST thread an explicit `requestKey` through `RefundOrderOptions`.
- **Handlers thread an action-scoped key.** `action-executor.ts` `partial_refund`, `redeem_points_as_refund`, and `dollar_replacement` compute `hashActionRefundKey("ticket", ctx.ticketId, order_id, amount_cents, reason)`; `returnsIssueRefund` computes `hashActionRefundKey("return", return_id, order_id, amount_cents, reason)` — see [[../libraries/refund]] Phase 2. Two different tickets legitimately refunding the same shape get distinct keys and both fire; a retry of the same action reuses the key and short-circuits at the pre-dispatch guard.
- **Pre-dispatch idempotency guard.** [[../libraries/refund]] `refundOrder` reads this table by `(workspace_id, order_id, request_key)` in `('succeeded','settled')` BEFORE the gateway call and short-circuits to `{ success: true, method, refund_id: vendor_refund_id }` on hit — the money doesn't move a second time. The post-success mirror insert plus the unique index `(order_id, request_key)` are the second and third layers behind this read.
- **`status='succeeded'` is the terminal Phase-1 state.** Phase 3 T+3d reconcile is what upgrades to `settled` / catches `reversed`; nothing else mutates this row.
- **Admin-only.** RLS is OFF — every write comes from server-side [[../libraries/refund]] via `createAdminClient()`. No anon read path.

## Queries

**Has this refund already fired?** (Phase 2 verify-by-refund-id guard, planned)
```ts
const { data } = await admin
  .from("order_refunds")
  .select("id, vendor_refund_id, status")
  .eq("order_id", orderId)
  .eq("request_key", requestKey)
  .in("status", ["succeeded", "settled"])
  .maybeSingle();
```

**Refunds pending T+3d settlement.** (Phase 3 cron)
```sql
select * from order_refunds
where status = 'succeeded'
  and requested_at < now() - interval '3 days';
```

**Refund line for a ticket-detail view.**
```sql
select vendor, vendor_refund_id, amount_cents, status, requested_at, settled_at
from order_refunds
where workspace_id = $1 and order_id = $2
order by requested_at desc;
```

## RLS

**Off.** Admin-only; every write goes through [[../libraries/refund]] `refundOrder` via `createAdminClient()`.

---

[[../README]] · [[orders]] · [[../libraries/refund]] · [[../inngest/refund-settlement-reconcile]] · [[../specs/refund-integrity-order-refunds-mirror-verify-by-id-settlement-reconcile]] · [[../../CLAUDE]]
