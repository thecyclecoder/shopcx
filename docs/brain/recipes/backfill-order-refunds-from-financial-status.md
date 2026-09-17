# Recipe: backfill order_refunds from `financial_status` (`backfill-order-refunds-from-financial-status`)

Close the historical gap in [[../tables/order_refunds]] for orders the vendor already refunded but that never landed a mirror row. Phase 2 of the [[../specs/vendor-side-refunds-must-mirror-into-the-refund-ledger]] spec — 28 of 69 fully-refunded orders under-reported when measured on 2026-09-11 ($2,429.19 invisible to the double-refund guard). Fixing the ingest path (Phase 1) only captures refunds from the moment it ships; this backfill catches everything before.

**Tool:** `scripts/_backfill-order-refunds-from-financial-status.ts`. Dry-run by default; `--apply` writes. Auto-ledgered in [[../tables/data_op_runs]] by [[../libraries/ship-time-backfill-detector]] because of the `_backfill-` prefix.

## Commands

```bash
# Dry-run — prints per-order decisions + total gap that would close
npx tsx scripts/_backfill-order-refunds-from-financial-status.ts

# Apply — inserts the missing gap rows into public.order_refunds
npx tsx scripts/_backfill-order-refunds-from-financial-status.ts --apply
```

## What it does

1. Reads every `public.orders` row with `LOWER(financial_status)='refunded'` and `total_cents > 0`, joined against a per-order sum of `public.order_refunds` where `status IN ('succeeded','settled')`.
2. Runs each row through [[../libraries/vendor-refund-mirror]] `decideFinancialStatusBackfill`. The pure predicate returns either a `gapCents` to write OR a `skip` reason (`not_fully_refunded` | `no_total` | `already_covered` | `over_total`).
3. Under `--apply`, per-order `INSERT ... SELECT ... WHERE sum + gap ≤ total_cents` — a compare-and-set against the write-time mirror sum so a concurrent Phase-1 live insert can't over-fill the ledger.
4. `ON CONFLICT (order_id, request_key) DO NOTHING` — the DB-level backstop when the same order is inserted twice in a race, or when the backfill is re-run.
5. Post-apply, verifies zero remaining fully-refunded orders under-mirrored. A non-zero count is a real drift signal.

## Row shape

Every backfilled row lands with:

- `vendor` — `shopify` when the order has `shopify_order_id`, `braintree` otherwise (same order-shape rule as the [[../specs/backfill-order-refunds-ledger-from-history]] Phase 1 backfill).
- `vendor_refund_id = null` — the order's `financial_status` is the evidence the vendor completed the refund, but the specific vendor id is not derivable from the order alone.
- `amount_cents = total_cents − sum(existing succeeded/settled)`.
- `request_key = backfill:financial_status:${order.id}` — stable per order.
- `status = 'settled'` — historical refund, already landed.
- `source = 'backfill'`.
- `requested_at = settled_at = orders.updated_at ?? orders.created_at` — best-effort historical stamp.

## Idempotency

- **Stable per-order key.** `backfillFromFinancialStatusRequestKey(order.id)` is deterministic, so a re-run collides on the `(order_id, request_key)` unique index and lands zero rows.
- **SC137733 proof.** The spec explicitly names order SC137733 as reconciled by hand on 2026-09-11. Its mirrored sum matches `total_cents`, so `decideFinancialStatusBackfill` returns `{ skip: true, reason: 'already_covered' }` and the script emits a no-op line — that's the cheapest available proof the idempotency works.
- **Concurrent Phase-1 landing.** The `INSERT ... SELECT ... WHERE sum + gap ≤ total_cents` guard re-reads the mirror sum at write time. If Phase 1's webhook / reconcile lands a row between our read and our write, the guard's inequality tightens accordingly and the row either lands smaller or is skipped by the ON CONFLICT.

## Scope discipline

- **Only `financial_status='refunded'` (case-insensitive).** A `partially_refunded` order is legitimately below its total; there is no unambiguous gap to infer, so the backfill leaves those alone.
- **Never over-refunds the ledger.** The predicate refuses to compute a gap that would push the sum past `total_cents`; the SQL guard re-asserts the same invariant at write time.
- **Never moves money.** This is ledger-only; the vendor already refunded the customer. See [[../libraries/vendor-refund-mirror]] Invariants.

## Verification (post-apply)

- The script's own post-apply query reports `0 fully-refunded orders still under-mirrored`.
- Re-run with `--apply`: `inserted 0` — every row skipped by the guard or the unique index.

## Related

[[../specs/vendor-side-refunds-must-mirror-into-the-refund-ledger]] · [[../libraries/vendor-refund-mirror]] · [[../libraries/refund]] · [[../libraries/ship-time-backfill-detector]] · [[../tables/order_refunds]] · [[../tables/orders]] · [[../tables/data_op_runs]]
