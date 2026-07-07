# inngest/digital-goods-delivery

Async job: on `orders/created` (fired from `/api/checkout` after a successful order write), iterate the order's `line_items` JSONB for any line carrying a `digital_good_id`, and for each downloadable digital good, download the asset from Supabase Storage server-side and send exactly one Resend email with the file attached. Idempotent per (order, digital_good) via [[../tables/digital_good_deliveries]] — the pre-dispatch guard reads that ledger before the send, and the DB-level unique `(order_id, digital_good_id)` index is the race-safe backstop. Phase 2 of [[../specs/digital-goods-delivery]].

**File:** `src/lib/inngest/digital-goods-delivery.ts`

## Functions

### `digital-goods-delivery`
- **Trigger:** event `orders/created` · fired from `src/app/api/checkout/route.ts` after the order insert + confirmation email (best-effort — a send failure never blocks the checkout response since the customer's card has already been charged)
- **Retries:** 3
- **Concurrency:** `concurrency: [{ limit: 5, key: "event.data.workspaceId" }]`

Handler shape:

1. Load the order (`workspace_id`, `id` → row with `line_items` JSONB, `email`, `order_number`). Missing order → `{ skipped: "order_not_found" }` — treated as a no-op, not an error (the row was deleted between event fire and this run).
2. `extractDigitalGoodIds(order.line_items)` → the distinct set of `digital_good_id`s referenced by any line. No hits → `{ deliveries: [] }`.
3. For each `digital_good_id`, run `step.run("deliver-{id}", deliverDigitalGoodOnce)`. The Inngest step id keeps a retry from re-firing a completed per-good delivery; the DB ledger + unique index is the cross-invocation backstop.

## `deliverDigitalGoodOnce(input)` — the per-good chokepoint

Exported for reuse by Phase 3's portal-resend action and for the Phase 2 idempotency test. Order of operations mirrors [[../libraries/refund]] `refundOrder` (check ledger → external side-effect → mirror-insert):

1. **Pre-dispatch idempotency guard.** Read [[../tables/digital_good_deliveries]] by `(workspace_id, order_id, digital_good_id)`. Row present → return `skipped_already_delivered` with the stored `resend_email_id` (Phase 3 renders "already delivered" from this).
2. **Resolve the good.** Read [[../tables/digital_goods]] by `(workspace_id, id)` and defensively re-check the two-legal-shapes invariant (`type='downloadable'` + `delivery='attachment'` + `asset_path is not null`). Phase 1 CHECK constraints already pin this at the DB — this is belt + suspenders. Non-downloadable → return `skipped_not_downloadable` (Phase 3 portal-resend calls the same chokepoint for coverage goods; the skip is expected).
3. **Download the asset server-side** via `admin.storage.from(DIGITAL_GOODS_BUCKET).download(asset_path)`. Same pattern as [[../inngest/import-subscriptions]]. Failure → return `skipped_missing_asset` (no ledger row written; next attempt tries again).
4. **Send the Resend email** with `attachments: [{ filename, content: Buffer }]`. From-line is `{brandName} <orders@{resend_domain}>` matching the storefront transactional convention. Sandbox mode is enforced by [[../libraries/email]] `getResendClient` — non-workspace-member recipient in sandbox → `skipped_resend_unavailable` (no ledger row written).
5. **Mirror-insert the ledger row** with `resend_email_id` + `delivered_at=now()`. On unique-constraint violation (`23505`, another invocation raced past the guard read), log the warn and treat the delivery as duplicated — the email is out either way. The unique index is the guarantee that AT MOST one row exists per (order, good).

## Downstream events sent

_None._ (This function is a leaf — it emails and writes the ledger; it does not enqueue further work.)

## Upstream events consumed

- `orders/created` — sent from `src/app/api/checkout/route.ts` after the order insert + confirmation-email step, in a best-effort `try/catch`. See [[../libraries/checkout]] (checkout flow) and the trigger site inline in the file.

## Tables written

- [[../tables/digital_good_deliveries]] — the delivery ledger + idempotency guard.

## Tables read (not written)

- [[../tables/orders]] — load the order's `line_items` JSONB + `email` + `order_number`.
- [[../tables/digital_goods]] — resolve the catalog row for the good referenced by a line.
- [[../tables/workspaces]] — resolve `transactional_from_name` for the Resend from-line (same shape as [[../libraries/email-storefront]] `getBrand`).

## Buckets read (Supabase Storage)

- `digital-goods` — the asset bucket. Read server-side via `.download(asset_path)`; the customer never sees a signed URL, they receive the file as an email attachment.

## Idempotency layers

1. **Inngest step id** (`deliver-{good_id}`) — a retry inside the same run cannot re-fire a completed step.
2. **Pre-dispatch ledger guard** — a fresh run consults [[../tables/digital_good_deliveries]] before sending, and short-circuits on hit.
3. **DB unique index** `(order_id, digital_good_id)` — the race-safe backstop when two concurrent runs both pass the ledger read; the second `.insert()` fails and lands in the try/catch. At most one row ever exists per (order, good).

---

[[../README]] · [[../integrations/inngest]] · [[../tables/digital_good_deliveries]] · [[../tables/digital_goods]] · [[../tables/orders]] · [[../libraries/email]] · [[../specs/digital-goods-delivery]] · [[../../CLAUDE]]
