# inngest/internal-dunning

Failed-payment recovery (dunning) for **internal** (Braintree-billed) subscriptions. The legacy dunning system ([[dunning]]) is built entirely around Appstle webhooks + Shopify card rotation, none of which exist for internal subs. This module is the internal path.

**File:** `src/lib/inngest/internal-dunning.ts`

Not an Inngest function itself — a library of handlers called from [[internal-subscription-renewals]] (decline + success), [[dunning]] (`dunningPaymentFailed` router), and the portal payment-recovery flow.

## Exports

| Function | Called from | Does |
|---|---|---|
| `handleInternalDunningFailure(input)` | `dunning.ts` `dunningPaymentFailed`, branched on `source === "internal_subscription_renewal"` | Opens/advances the dunning cycle, logs `payment_failures` + `customer_events`, schedules the next payday retry (moves `next_billing_date`), emails on terminal decline, cancels on exhaustion. |
| `closeInternalDunningOnSuccess(ws, subId, internalContractId, custId)` | `internal-subscription-renewals.ts` success path | Marks an open cycle `recovered` + logs `payment.recovered` (replaces the Appstle `billing-success` webhook). |
| `reactivateDunningCancelledSubs(ws, customerIds[])` | `portal/handlers/payment-method-update.ts` recover flow | Reactivates subs cancelled **by dunning** (have an `exhausted`/`cancelled` cycle — never voluntary cancels), sets a fresh `next_billing_date`, marks cycle `recovered`. Returns count. |

## Key behaviour

- **Cycle key:** `dunning_cycles.shopify_contract_id` holds the `internal-*` id (internal subs have no Shopify contract).
- **Retry engine = the daily renewal cron.** On failure, `next_billing_date` → next payday (`getNextPaydayDates`); `internalSubscriptionRenewalCron` re-attempts. No Appstle billing-attempt, no separate retry cron.
- **Attempt counting:** counts `payment_failures` rows (last 90d, `succeeded=false`) for the sub. `MAX_PAYDAY_RETRIES = 4` → 5th failure exhausts.
- **Email timing (settled decision):** terminal Braintree declines (`BRAINTREE_TERMINAL` set — 2004/2005/2007/…/2057, expired/closed/invalid card) email the recovery magic-link **immediately**; soft declines (insufficient funds, etc.) wait until exhaustion. Email = `generatePaymentRecoveryLink` (7-day), attached to the most-recent open ticket (tag `dunning:active`).
- **Exhaustion:** cancel the sub (`subscription.cancelled`, reason `dunning_exhausted`); recovery reactivates it. `payment_update_sent` guards against double-emailing.

## customer_events written

- `subscription.payment_failed` (each attempt)
- `dunning.recovery_email_sent`
- `subscription.cancelled` (reason `dunning_exhausted`)
- `payment.recovered` / `subscription.reactivated`

## Tables written

- [[../tables/dunning_cycles]]
- [[../tables/payment_failures]]
- [[../tables/subscriptions]]
- [[../tables/customer_events]]
- [[../tables/ticket_messages]] (recovery email)

---

[[../README]] · [[internal-subscription-renewals]] · [[dunning]] · [[../lifecycles/dunning]] · [[../libraries/magic-link]] · [[../lifecycles/customer-portal]] · [[../../CLAUDE]]
