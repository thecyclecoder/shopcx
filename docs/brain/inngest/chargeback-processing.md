# inngest/chargeback-processing

Shopify dispute pipeline: classify → auto-cancel sub OR review → won/lost. Writes `chargeback_events`, `chargeback_subscription_actions`.

**File:** `src/lib/inngest/chargeback-processing.ts`

## Functions

### `chargeback-received`
- **Trigger:** event `chargeback/received`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.chargebackEventId" }]`


### `chargeback-won`
- **Trigger:** event `chargeback/won`
- **Retries:** 2


### `chargeback-lost`
- **Trigger:** event `chargeback/lost`
- **Retries:** 2


### `chargeback-evidence-reminder`
- **Trigger:** cron `0 9 * * *`
- **Retries:** 2


## Downstream events sent

_None._

## Tables written

- [[../tables/chargeback_events]]
- [[../tables/chargeback_subscription_actions]]
- [[../tables/customers]]
- [[../tables/dashboard_notifications]]
- [[../tables/fraud_cases]]
- [[../tables/ticket_messages]]
- [[../tables/tickets]]

## Tables read (not written)

- [[../tables/customer_links]]
- [[../tables/orders]]
- [[../tables/subscriptions]]
- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
