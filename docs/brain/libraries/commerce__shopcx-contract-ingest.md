# `src/lib/commerce/shopcx-contract-ingest.ts`

Turns a Shopify subscription contract that was born **outside our own code** into a ShopCX
subscription. The other direction from [[commerce__shopify-subscription-migrate]]: that one creates
contracts, this one adopts them.

## ⭐ Why this exists

Almost all storefront traffic lands on **Shopify PDPs**, and a PDP checkout with a selling plan
creates a real `SubscriptionContract` our app owns. Shopify announces it on
`subscription_contracts/create` — a topic that was registered on the live shop but fell to the
webhook route's `default:` no-op.

So the contract existed on Shopify and **nowhere in ShopCX**: no portal row, no renewal candidate,
no ticket context, no analytics. And [[../lifecycles/shopcx-subscriptions]]'s first law is that
**Shopify charges nothing on its own** — an un-ingested contract is a customer who subscribed and
would never be billed, with no error anywhere to say so. Two live ones were found this way
(36020093101 / 36020289709, both 2026-09-15 PDP checkouts).

## ⚠️ Not every app-owned contract belongs here

We create contracts ourselves, and Shopify fires the same topic for those:

| Rail | Claim marker | Why ingesting it would be wrong |
|---|---|---|
| Appstle migration | `appstle_contract_snapshots.migrated_to_contract_id` (stored as a **GID**) | duplicates a customer who already has a row, and the migration is mid-flight |
| one-time charges | `one_time_charges.shopify_contract_id` | turns a single $1 charge into a recurring subscription |
| a prior ingest | `subscriptions.shopify_contract_id` | duplicate row |

`originOrder` looks like the obvious "born at checkout?" discriminator and **is not** — measured
2026-09-17 across all 23 app-owned contracts, contracts we created with
`subscriptionContractAtomicCreate` also carry one. Ownership is decided by our own markers.

A fourth guard is status: **only `ACTIVE` or `PAUSED` is ingested.** `create` never fires for a
cancelled contract, so this only bites the backfill path — where it matters. Caught minting a
`cancelled` subscription row for a dead test contract (36047061165) while this module was being
verified; rows like that inflate churn with relationships that never existed.

## Exports

| Export | What |
|---|---|
| `ingestShopifyContract(ws, contractId, {force?})` | claim-check → read → resolve customer → upsert the `subscriptions` row → link the origin order |
| `syncShopifyContract(ws, contractId)` | refresh an ALREADY-ingested row after a Shopify-side edit; falls through to a full ingest if no row exists |

Neither throws — both return `{ingested: false, reason}`.

`force` skips only the "already ingested" arm, never the migration / one-time-charge arms: those are
correctness boundaries, not duplicate protection.

## What gets written

- **`billing_source: 'shopcx'`** — the whole point. Without it the renewal cron never selects the row
  and the portal routes edits to the wrong engine.
- **`items`** in the Appstle shape every reader already speaks, with `price_cents` as the REALIZED
  per-unit rate (base less our structural discounts), matching `mirrorContractToItems` in
  [[commerce__shopcx-line-ops]]. A customer coupon is excluded on purpose — it is not part of the
  line's standing price. Verified on 36020093101: $69.95 → 25% S&S → 8% volume = **$48.27/unit**,
  exactly Shopify's own `lineDiscountedPrice` of $96.54 for qty 2.
- **`applied_discounts`** carrying `targetType`, so the money resolver can exclude shipping-target
  (free-shipping) discounts from the product subtotal instead of zeroing it — the Melissa-class
  portal bug (`computeDisplayCoupon` in [[commerce__price]]).
- **the origin order link** straight from `originOrder`, no heuristics. The Appstle path has to guess
  from tags and SKUs ([[subscription-order-link]]); here Shopify just tells us. Only ever FILLS a
  null link.

**NOT `payment_method_id`.** That column is a uuid FK to `customer_payment_methods` — the pinned
Braintree card on the INTERNAL rail. A Shopify `CustomerPaymentMethod` gid is a different thing and
the write is rejected by the type (it was, first run). The contract's payment method stays on
Shopify, where `subscriptionBillingAttemptCreate` reads it.

## `syncShopifyContract` is deliberately narrower

The `update` topic fires for every edit **we** make too, so the sync must not undo what ShopCX owns:

- `next_billing_date` is skipped while a dunning cycle is `active`/`skipped` — dunning holds a past
  date on purpose and sets the real one when it finishes. Same rule as the Appstle webhook.
- a row billed by another engine is refused outright (verified: an `appstle` row returns
  `row is billed by appstle`).
- cancel-truth is preserved: `status='cancelled'` forces `next_billing_date` null and keeps the
  FIRST `cancelled_at`.

## Gotchas

- **The claim check is only as good as the marker.** Clearing `migrated_to_contract_id` by hand (as
  the 2026-09-17 migration test cleanup did) makes a migrated contract look adoptable. The status
  guard is the backstop.
- **`resolveCustomer` order is shopify id → email → insert**, and it backfills
  `customers.shopify_customer_id` when it matched on email, so the next contract resolves on the
  first try. The delay in front of the ingest is partly so `orders/create` has already made the
  customer row and we do not mint a duplicate.
- **250 lines is the read cap**; past that the items mirror is logged as TRUNCATED rather than
  silently partial.

## Related

[[../inngest/shopcx-contract-ingest]] · [[commerce__shopify-subscription-client]] ·
[[commerce__shopify-subscription-migrate]] · [[commerce__shopcx-line-ops]] ·
[[shopify-webhook-register]] · [[../tables/subscriptions]] ·
[[../lifecycles/shopcx-subscriptions]]
