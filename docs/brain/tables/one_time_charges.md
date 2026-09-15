# `public.one_time_charges`

A **single** charge against a customer's vaulted **Shopify** payment method. Written only by
[[../libraries/commerce__shopify-one-time-charge]]; driven by [[../inngest/one-time-charges]].

## ⭐ Two rails, one queue — and Braintree wins

| `rail` | when | how |
|---|---|---|
| `braintree` | the customer has an active Braintree card — **preferred, tried first** | `chargeOneTimeOrder` ([[../libraries/one-time-charge]]) charges directly and builds the order. No Shopify contract at all. |
| `shopify` | no Braintree token — a Shop Pay agreement or a Shopify-vaulted card | build a throwaway subscription contract, bill it once, cancel it |

The Braintree preference is the same principle as the payment-recovery email routing to our own
flow: **anywhere we can keep someone on internal rails, we do.** The Shopify rail exists only for
the customers we cannot reach any other way.

`chargeOneTimeOrder` shipped in PR #2737 with **no production caller**; this queue is its front
door.

⚠️ A Braintree DECLINE does not fall through to the Shopify rail. The customer's card was already
asked — charging a second rail would risk billing them twice. Only the *absence* of a Braintree
token falls through.

## Why the Shopify rail needs a contract at all

A Shop Pay agreement or a Shopify-vaulted card cannot be charged by any Admin API call except
`subscriptionBillingAttemptCreate`, which bills a subscription **contract**. So the only way to
take a single payment from one — no checkout, no customer interaction — is to build a contract,
bill it once, and cancel it.

## ⭐ Why it is NOT a row in `subscriptions`

`subscriptions` is read by analytics (active counts, MRR, churn, recurring-order rate), the
customer portal, the cancel flow, dunning, and the Appstle→internal migration sweeps. A one-time
charge living there is excluded from each of those **only by a predicate every reader has to
remember**.

That exact shape has already failed here. `is_internal = false` meant "Appstle" while there were
two engines, and silently widened to include ShopCX the moment there were three —
`migrateCustomerAppstleSubsToInternal` then picked such a row up **on portal page load** and would
have cancelled the live contract and flipped the row to internal with zero items. A `kind` column
would be that mistake a second time. A separate table cannot silently widen: the exclusion is
structural, not remembered.

## ⚠️ Keeping it out of the stats takes TWO things, not one

| | Value | Why |
|---|---|---|
| `orders.subscription_id` | **NULL** | covers every reader keyed on the join |
| `orders.order_type` | **`one_time`** | covers every reader keyed on the type |

Both are required. The charge bills through `subscriptionBillingAttemptCreate`, so Shopify stamps
the order `source_name = 'subscription_contract_checkout_one'` — **byte-identical to a real ShopCX
renewal** — and the workspace's `order_source_mapping` maps that source to **`recurring`**. Without
the reclassify the order counts as a renewal on the dashboard, in recurring-order analytics, and in
the rules engine (which exposes `order.order_type` as a condition field).

The reclassify happens in the sweeper, not inline: the order webhook usually has not landed when
the attempt settles (measured — `order_id` was still null the moment SC138755 was charged).

`orders.order_type`'s CHECK had to be widened to accept `one_time`; the first attempt was rejected
with `23514` and, because the caller ignored the error, **no-opped in silence**. The SDK now reads
that error and logs loudly.

## ⚠️ `billingPolicy.maxCycles` does NOT make a charge one-time

Verified live on contract `36017143981`, created with `minCycles: 1, maxCycles: 1`: it still
computed **8 billing cycles**, identical to an uncapped contract, and cycles #2 and #3 were still
addressable by selector. Shopify stores the policy and computes a calendar; it enforces neither.

**Cancelling the contract is the real guarantee** — done in a `finally`, on every settled path
including a decline. A contract left ACTIVE is a live billing instrument attached to a customer who
agreed to exactly one charge. A failed cancel is written to `error` as
`contract_not_cancelled:<id>:<reason>` and retried by the sweeper.

## No cycle-charge claim row

[[subscription_cycle_charges]] exists because a *recurring* sub has many cycles and needs
per-(subscription, cycle) idempotency. A one-time charge has exactly one charge, so per-cycle
keying is meaningless — **this row is the claim**. `status` moves `pending → charging` under a
compare-and-set (`UPDATE … WHERE status='pending'` returning rows), atomic in Postgres, the same
pattern ship-time backfills use. Shopify's own `idempotencyKey` is the second guard.

⚠️ PostgREST returns **no error** when an update matches zero rows, so the returned row count is
the only signal that the claim lost.

## Lifecycle

| status | meaning |
|---|---|
| `pending` | created, waiting for `charge_at`. The only state the cron picks up, and the only one that can be cancelled. |
| `charging` | claimed by a run. A crash leaves it here; `charging_since` makes that visible and reclaimable. |
| `charged` | Shopify accepted and created the order. Terminal. |
| `failed` | declined, or the contract could not be built. Terminal. |
| `cancelled` | pulled before it ran. Terminal. |

**A decline is NOT handed to dunning.** A one-time charge is not a subscription at risk — rotating
the customer's card and emailing them about a subscription they do not have would be wrong.

### Where a decline shows up

The row is the source of truth, but **nothing reads it**, so a decline also lands in two places:

| | what for |
|---|---|
| [[payment_failures]] (`attempt_type='one_time'`, `subscription_id` NULL) | the canonical decline ledger — decline-rate analytics by card and error code |
| [[customer_events]] (`one_time_charge.declined`) | the customer timeline agents and tickets actually read |

`subscription_id` stays NULL, which is also the mechanism that keeps dunning from adopting the row:
dunning selects on it. The `one_time` attempt_type makes that explicit to anyone reading a query.

⚠️ The gap was real, not theoretical. On 2026-09-15 a live customer was declined **$196.08**
(`PAYMENT_METHOD_DECLINED`, Amex •1002) and their timeline showed 27 events, none of them the
decline — an agent picking up the ticket had no way to see it. The throwaway contract WAS cancelled
correctly, which is the safety property holding under a real decline for the first time in
production.

**A declined charge does not auto-retry.** `failed` is terminal for the cron — the cron only picks up
`pending`, by design, so nothing re-drives a decline without a human decision. To recover the sale,
an operator (or an agent flow) calls `retryOneTimeCharge(workspaceId, chargeId, newShopifyPaymentMethodId)`:
it appends the prior attempt to `attempt_history`, clears the last-attempt outcome fields on the
row, reopens the row from `failed` to `pending` via a compare-and-set on `status='failed'`, and
sets `shopify_payment_method_id` to the new choice. Same intent, same row, no duplicate charge —
recovering via a second `one_time_charges` row would risk a double bill if the first row is later
re-executed by hand.

Refused conditions:

| refusal | what it means |
|---|---|
| `not_failed (<status>)` | the row is not in `failed` (only failed rows can retry) |
| `not_failed` | zero-row CAS — another actor reopened the row first |
| `same_method_as_last_decline` | the new method equals the one that just declined — a real decline for no diagnostic gain, refused |
| `payment_method_required` | the new method id is empty |
| `charge_not_found` | no such row for this workspace |

⚠️ The same-method guard checks against `payment_method_id` (the method the executor actually
billed), not `shopify_payment_method_id` (the caller's chosen field), because the caller may not
have named a method — the executor picked `live[0]` and stamped it — and the truth of "what just
declined" lives on the billed field.

## Columns

`id` · `workspace_id` · `customer_id` · `shopify_customer_id` · `shopify_contract_id` (the
throwaway contract; NULL before the run, a *cancelled* contract after) ·
`shopify_payment_method_id` (INPUT — the caller-chosen method to bill; NULL preserves the
first-non-revoked default) · `payment_method_id` (OUTPUT — the method the executor actually
billed) · `attempt_history` (jsonb array of prior attempt signatures, appended by
`retryOneTimeCharge` — see below) ·
`status` · `items` (jsonb, **internal variant UUIDs** — never `shopify_variant_id`) ·
`amount_cents` · `currency` · `charge_at` · `reason` · `created_by` · `order_id` ·
`shopify_order_name` · `billing_attempt_id` · `rail` (`braintree` | `shopify`) · `error` ·
`attempts` · `charging_since` ·
`charged_at` · `failed_at` · `cancelled_at` · `created_at` · `updated_at`

`reason` and `created_by` are required at create time — a charge nobody can explain is a
chargeback.

### Naming the card

`shopify_payment_method_id` on the row (input on `CreateOneTimeChargeInput.shopifyPaymentMethodId`)
is optional and holds a `gid://shopify/CustomerPaymentMethod/…` id. When set, the executor
validates it against the customer's live method list at charge time and refuses if the id is
revoked (`chosen_payment_method_revoked`) or absent (`chosen_payment_method_not_found`) — a stale
id fails **loudly** rather than silently falling back to a different card than the one authorised.
A caller-named Shopify method also bypasses the Braintree-first preference, because the
authorisation names the Shopify rail specifically. When it is NULL, behaviour is unchanged: the
first non-revoked method wins.

Selection is by method id, never by last four digits. One underlying card can appear as multiple
methods on the same customer (e.g. a raw card and a wallet agreement on the same PAN), which is
precisely how the 2026-09-15 decline surfaced.

`payment_method_id` records the id the executor actually billed and is stamped **before** the
Shopify contract call, so a contract-create or attempt failure is still attributable to a specific
instrument afterwards.

## Verified live

2026-09-15, order **SC138755**: `$1.00` charged in 11.3s, contract `36017438893` created and left
`CANCELLED`, re-run correctly returned `skipped (not_pending)`, order landed with
`subscription_id: null` and was reclassified to `order_type: one_time` by the sweeper. Refunded.

## Related

[[../libraries/commerce__shopify-one-time-charge]] · [[../libraries/one-time-charge]] ·
[[../inngest/one-time-charges]] ·
[[subscription_cycle_charges]] · [[orders]] · [[subscriptions]] ·
[[../lifecycles/shopcx-subscriptions]]
