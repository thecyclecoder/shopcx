# inngest/internal-subscription-renewals

Renews `subscriptions.is_internal=true` rows on schedule (post-Appstle scheduler stub).

**File:** `src/lib/inngest/internal-subscription-renewals.ts`

## Functions

### `internal-subscription-renewal-cron`
- **Trigger:** cron `0 9 * * *`
- **Retries:** 1
- **Control Tower heartbeat** carries the per-cycle outcome breakdown: `produced = { dispatched, last_cycle_outcomes, last_cycle_since }`. Because fan-out is async (today's attempts haven't run when the cron's beat is written), `last_cycle_outcomes` is the **most-recently-COMPLETED** cycle — `aggregateRenewalOutcomes` over the outcome beats since the PREVIOUS cron beat. (The Control Tower's outcome-distribution assertion aggregates the LIVE current cycle every ~15m for timely spike detection.) ([[../specs/control-tower-renewal-integrity-assertions]] P1.)


### `internal-subscription-renewal-attempt`
- **Trigger:** event `internal-subscription/renewal-attempt`
- **Retries:** 3
- **Concurrency:** `concurrency: [{ limit: 10 }]`
- **Outcome beats:** every terminal path emits ONE `emitRenewalOutcomeHeartbeat(outcome)` ([[../libraries/control-tower]]) — `charged` · `declined_to_dunning` · `skipped_no_payment_method` · `skipped_zero_total` · `comp_shipped` · `comp_blocked` (comp gate / not-allowlisted) · `skipped_other` (benign not_internal/status/no_customer state changes). The only uniform channel that captures SKIPS (which write no transaction row), feeding the Control Tower **outcome-distribution** assertion. Uncaught errors aren't beat — a sub that errored never advances, so it's caught by the **renewal-integrity** overdue assertion instead.


## Comp branch (free subs)

Before the normal load-context (which hard-requires a PM), `renewal-attempt` checks [[../tables/subscriptions]].`comp`. A `comp=true` sub ships **free**: **gate first** — if the customer's [[../tables/customers]].`comp_role` is null/invalid → FAIL CLOSED (`type='comp'` `status='failed'` transaction + `subscription.comp_renewal_failed` event, no shipment, no advance). Allowlisted → skip PM / Braintree / Avalara / shipping, create a $0 `financial_status='paid'` order (`source_name='internal_subscription_comp_renewal'`, does **not** trip dunning), advance `next_billing_date`, hand to Amplifier, record a `type='comp'` succeeded $0 transaction, log `subscription.comp_shipped`. Never routes to dunning. See [[../lifecycles/subscription-billing]] § Comp.

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
- [[../tables/customer_events]] (`subscription.payment_failed` on decline; `subscription.comp_shipped` / `subscription.comp_renewal_failed` on the comp branch)

## Tables read (not written)

- [[../tables/customer_payment_methods]]
- [[../tables/customers]]

---

[[../README]] · [[../integrations/inngest]] · [[internal-dunning]] · [[../lifecycles/dunning]] · [[../../CLAUDE]]
