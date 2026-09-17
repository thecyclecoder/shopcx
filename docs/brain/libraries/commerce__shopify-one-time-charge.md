# `src/lib/commerce/shopify-one-time-charge.ts`

The queue behind [[../tables/one_time_charges]], and the Shopify-vaulted rail.

⚠️ Not to be confused with [[one-time-charge]] (`src/lib/one-time-charge.ts`), which charges a
vaulted **Braintree** card. This module is the front door for BOTH and prefers that one — see
§ Two rails. The name collision is why this file carries the `shopify-` prefix and why its item
type is `QueuedChargeItem` rather than `OneTimeChargeItem` (that name belongs to the Braintree
module).

## Two rails

`executeOneTimeCharge` tries **Braintree first** (`chargeViaBraintreeIfPossible` →
`chargeOneTimeOrder`): no throwaway contract, no order-source ambiguity, and the customer stays on
internal rails. It falls through to the Shopify contract dance only when there is no active
Braintree token. A Braintree **decline** does not fall through — the card was already asked, and a
second rail would risk a double charge.

The Braintree guard's `customer_payment_methods` lookup spans the queue row's link group via
[[customer-links]] `linkGroupIds` (payment-method-lookups-must-span-linked-accounts spec Phase 1)
so a card vaulted on a linked sibling is still found. The queue row's `customer_id` stays the
identity for writes — the resulting order + transaction attribute to the person the charge was
queued against, not to whichever sibling happens to hold the card. Ground truth: ticket
`4ed092c4` — MasterCard ••9762 vaulted on customer `affcdc47`, charge required linked sibling
`40c66b13` (has `shopify_customer_id`); pre-fix, the narrow lookup missed the card and fell
through to bill an Amex ••1002 that had already declined.

### `rail_reason` — a rail may not silently swap to another card (Phase 2)

`rail='shopify'` alone is ambiguous: it can mean the caller **named** a Shopify method (explicit
authorisation for this rail) or Braintree **missed** and we fell through. Post-Phase-1 a miss
should be rare enough to be suspicious, so the executor stamps `rail_reason` at every
rail-selection settle site to make the fall-through legible on the row:

- `braintree_preferred` — Braintree ran (its guard found a card in the link group).
- `braintree_indeterminate` — Braintree threw. Terminal + loud (never falls through — the sale
  API has no idempotency key, so a settled-then-timed-out response is indistinguishable from one
  that never happened).
- `shopify_named_instrument` — `shopify_payment_method_id` was set on the row; Braintree was
  bypassed.
- `shopify_no_braintree_token` — Braintree returned null (no active token in the link group).

⭐ **A named-instrument miss REFUSES rather than falls through.** When the caller named a
Shopify method and `resolveShopifyContext` returns `chosen_payment_method_not_found` /
`chosen_payment_method_revoked`, the executor forwards the error via `fail(...)` — it must never
silently fall back to a different card than the one authorised. Charging a different card than
the one authorised is the failure Phase 2 exists to prevent.

`retryOneTimeCharge` clears `rail_reason` on the reopened row and preserves the prior value on
`attempt_history` (part of the decline signature the human sees before choosing which card to
try next). The sweeper's crash-recovery path preserves any pre-crash `rail_reason` and otherwise
infers `shopify_named_instrument` vs `shopify_no_braintree_token` from the row's
`shopify_payment_method_id`.

## Exports

| Export | Notes |
|---|---|
| `createOneTimeCharge(ws, {customerId, items, reason, createdBy, chargeAt?, currency?})` | records intent ONLY — no Shopify object is created, so a queued charge can be pulled with one UPDATE and leaves nothing behind |
| `retryOneTimeCharge(workspaceId, chargeId, newShopifyPaymentMethodId)` | reopens a `failed` charge from `failed` to `pending` under a new payment method, preserving the prior attempt in `attempt_history` and refusing if the new method equals the one that declined |
| `cancelOneTimeCharge(ws, chargeId)` | only a `pending` row can be pulled |
| `executeOneTimeCharge(ws, chargeId)` | claim → contract → bill → cancel |
| `sweepOneTimeCharges(ws)` | reconcile crashed runs, cancel leaked contracts, link + reclassify orders |
| `ONE_TIME_ORDER_TYPE` | `"one_time"` — the `orders.order_type` stamp (Shopify rail only; the Braintree rail writes its own order) |

`reason` + `createdBy` are required at create: a charge nobody can explain is a chargeback.
`items` carry **internal variant UUIDs** (CLAUDE.md § internal joins use UUIDs); they resolve to
Shopify variant ids and prices at charge time, not at queue time.

## Refusals that happen at CREATE, deliberately

A customer with no `shopify_customer_id` has no vaulted Shopify payment method to reach, which
makes the whole mechanism pointless. That is refused at create so it surfaces to whoever asked,
rather than failing on a cron tick days later.

## Ordering inside `executeOneTimeCharge`

1. **Claim** — compare-and-set `pending → charging` on the row itself. Row count is the signal.
2. **Resolve context** — the customer's first non-revoked vaulted payment method (a revoked one
   still appears in the list and would fail the attempt with an opaque decline) + default address.
3. **Create the contract** with `nextBillingDate` 30 days out — Shopify rejects a past one — and
   `maxCycles: 1` as honest metadata that **does not bind** (see below).
4. **Bill cycle index 1.** Addressed by INDEX, not date: a fresh contract's cycle 1 starts at
   `createdAt`, and index avoids any date/timezone edge on a contract seconds old.
5. **Settle.** `pending` (3DS / poll timeout) stays `charging` for the sweeper. A decline settles
   `failed`. A transport fault releases the claim and throws so Inngest retries.
6. **`finally`: cancel the contract** — on every settled path, success or decline.

## ⚠️ `maxCycles` does not make anything one-time

Verified on contract `36017143981`: created with `minCycles/maxCycles = 1`, it still computed 8
billing cycles and cycles #2/#3 stayed addressable. Cancellation in the `finally` is the guarantee.
A failed cancel is recorded on the row as `contract_not_cancelled:<id>:<reason>` and logged loudly,
because a live contract attached to a customer who agreed to one charge is the worst residue this
code can leave.

## Keeping it out of subscription stats

Two things, both required — `orders.subscription_id` NULL **and** `orders.order_type = 'one_time'`.
The order's `source_name` is identical to a real renewal's, and the workspace maps that source to
`recurring`. Full reasoning on [[../tables/one_time_charges]].

## Related

[[../tables/one_time_charges]] · [[one-time-charge]] · [[../inngest/one-time-charges]] ·
[[commerce__shopify-subscription-client]] · [[commerce__subscription]] ·
[[../lifecycles/shopcx-subscriptions]]
