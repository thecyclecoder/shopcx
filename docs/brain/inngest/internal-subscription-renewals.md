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


## Downstream events sent

- `dunning/payment-failed`

## Tables written

- [[../tables/orders]]
- [[../tables/subscriptions]]
- [[../tables/transactions]]

## Tables read (not written)

- [[../tables/customer_payment_methods]]
- [[../tables/customers]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
