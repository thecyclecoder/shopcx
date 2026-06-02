# inngest/dunning

Dunning orchestrator: payment-failed → card rotation → payday retries → cycle action. Plus new-card-recovery + billing-success cleanup. Writes `dunning_cycles`, `payment_failures`. See Phase 5 in CLAUDE.md.

**File:** `src/lib/inngest/dunning.ts`

## Functions

### `dunning-payment-failed`
- **Trigger:** event `dunning/payment-failed`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 3, key: "event.data.workspace_id" }]`


### `dunning-new-card-recovery`
- **Trigger:** event `dunning/new-card-recovery`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 3, key: "event.data.workspace_id" }]`


### `dunning-billing-success`
- **Trigger:** event `dunning/billing-success`
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 5, key: "event.data.workspace_id" }]`


### `dunning-payday-retry-cron`
- **Trigger:** cron `0 * * * *`
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1 }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/dashboard_notifications]]
- [[../tables/subscriptions]]
- [[../tables/ticket_messages]]
- [[../tables/tickets]]

## Tables read (not written)

- [[../tables/customers]]
- [[../tables/dunning_cycles]]
- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
