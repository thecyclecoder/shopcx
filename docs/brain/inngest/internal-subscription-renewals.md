# inngest/internal-subscription-renewals

Renews `subscriptions.is_internal=true` rows on schedule (post-Appstle scheduler stub).

**File:** `src/lib/inngest/internal-subscription-renewals.ts`

## Functions

### `internal-subscription-renewal-cron`
- **Trigger:** cron `0 9 * * *`
- **Retries:** 1


### `internal-subscription-renewal-attempt`
- **Trigger:** event `internal-subscription/renewal-attempt`
- **Retries:** 3
- **Concurrency:** `concurrency: [{ limit: 10 }]`


## Dunning hooks

- **On decline:** fires a **complete** `dunning/payment-failed` (`source: "internal_subscription_renewal"`, `shopify_contract_id` = the `internal-*` id, Braintree `error_code`/`error_message`) **and** logs a `customer_events` `subscription.payment_failed` directly. The dunning router branches on that `source` into [[internal-dunning]] — never the Appstle path.
- **On success:** calls `closeInternalDunningOnSuccess` ([[internal-dunning]]) to mark any open cycle `recovered` (no Appstle `billing-success` webhook exists for internal subs).
- **Retry engine:** [[internal-dunning]] moves `next_billing_date` to the next payday on failure; THIS cron re-attempts then. No separate retry function.

## Downstream events sent

- `dunning/payment-failed` (with `source: "internal_subscription_renewal"`)

## Tables written

- [[../tables/orders]]
- [[../tables/subscriptions]]
- [[../tables/transactions]]
- [[../tables/customer_events]] (`subscription.payment_failed` on decline)

## Tables read (not written)

- [[../tables/customer_payment_methods]]
- [[../tables/customers]]

---

[[../README]] · [[../integrations/inngest]] · [[internal-dunning]] · [[../lifecycles/dunning]] · [[../../CLAUDE]]
