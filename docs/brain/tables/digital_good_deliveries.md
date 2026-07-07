# digital_good_deliveries

The **delivery ledger** for digital-goods post-purchase attachment emails — one row per (order, digital_good) pair the Phase 2 Inngest function has successfully emailed. Written by [[../inngest/digital-goods-delivery]] on Resend success. The `unique (order_id, digital_good_id)` index + the pre-dispatch guard read are the two backstops that enforce Phase 2's "exactly one email per (order, good)" invariant — same three-layer shape as [[order_refunds]] / [[../libraries/refund]] (read → act → mirror-insert; unique index is the race-safe DB backstop). Phase 2 of [[../specs/digital-goods-delivery]].

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `order_id` | `uuid` | — | → [[orders]].id · ON DELETE CASCADE · never the human-facing `order_number` / `shopify_order_id` |
| `digital_good_id` | `uuid` | — | → [[digital_goods]].id · ON DELETE CASCADE |
| `resend_email_id` | `text` | ✓ | Resend message id returned from `resend.emails.send`. Nullable to leave room for a defensive best-effort row; the guarded happy path always sets it. |
| `delivered_at` | `timestamptz` | — | default `now()` — when the Resend send succeeded (post-dispatch), not when the guard was consulted. Phase 3 portal-resend renders "last delivered" from here. |
| `created_at` / `updated_at` | `timestamptz` | — | default `now()` |

**Unique:** `(order_id, digital_good_id)` — the DB-level idempotency backstop. A same-shape retry hits this constraint and lands in the delivery function's try/catch (the email already went out; log and move on). Same shape as [[order_refunds]] `(order_id, request_key)`.

**Indexes:** `digital_good_deliveries_order_good_uidx` (the unique above); `digital_good_deliveries_workspace_order_idx` on `(workspace_id, order_id)` — the Phase 3 portal-resend lookup ("does this customer's order still have the delivery on file so I can resend it?").

## Foreign keys

**Out:** `workspace_id` → [[workspaces]].id · `order_id` → [[orders]].id · `digital_good_id` → [[digital_goods]].id.

## Invariants

- **Written from the chokepoint only.** Every code path that fires a downloadable-attachment email resolves to [[../inngest/digital-goods-delivery]] `deliverDigitalGoodOnce`; the ledger row is written there and nowhere else, so no path can email a PDF without an audit row.
- **Pre-dispatch idempotency guard.** `deliverDigitalGoodOnce` reads this table by `(workspace_id, order_id, digital_good_id)` BEFORE the Resend send and short-circuits to `status='skipped_already_delivered'` on hit — the customer's inbox stays clean of duplicate PDFs on retry.
- **Race backstop is the unique index.** A concurrent invocation that raced past the guard read lands in the `.insert(...)` catch with a 23505 constraint violation; the email is out either way (both winners sent it; the guard filter for the later winner returned empty because the earlier winner had not yet inserted). The unique index guarantees at most one row.
- **Row = successful Resend send.** The ledger is only written on Resend success. A skip (sandbox-blocked, missing asset, non-downloadable, resend-unavailable) writes no row — the guard read on the next attempt returns empty and the function tries again.
- **Admin-only.** RLS is ON with a `service_role`-only policy — every read/write goes through server-side code via `createAdminClient()`. No anon read path.

## Queries

**Has this good already been delivered for this order?** (the pre-dispatch guard)
```ts
const { data } = await admin
  .from("digital_good_deliveries")
  .select("id, resend_email_id")
  .eq("workspace_id", workspaceId)
  .eq("order_id", orderId)
  .eq("digital_good_id", digitalGoodId)
  .maybeSingle();
```

**Portal-resend catalog for an order.** (Phase 3 planned)
```ts
const { data } = await admin
  .from("digital_good_deliveries")
  .select("digital_good_id, resend_email_id, delivered_at")
  .eq("workspace_id", workspaceId)
  .eq("order_id", orderId)
  .order("delivered_at", { ascending: false });
```

## RLS

**On, admin-only.** `digital_good_deliveries_service` policy grants `service_role` full access; every read/write flows through server-side code via `createAdminClient()`. No anon / member read path.

## Callers

- [[../inngest/digital-goods-delivery]] `deliverDigitalGoodOnce` — reads (pre-dispatch guard) + writes (mirror). The sole chokepoint.
- **Phase 3 (planned)** — the portal-resend action reads by `(workspace_id, order_id)` to render the customer's downloadable-goods list AND re-invokes `deliverDigitalGoodOnce`, which will short-circuit on the existing ledger row. Portal-resend cannot fire an email for a good the customer does not already own because the ledger read is the ownership proof.

---

[[../README]] · [[digital_goods]] · [[orders]] · [[workspaces]] · [[../inngest/digital-goods-delivery]] · [[../specs/digital-goods-delivery]] · [[../../CLAUDE]]
