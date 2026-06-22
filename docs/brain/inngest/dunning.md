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

**Control Tower heartbeat fires on every tick, including empty ones.** The `if (cycles.length === 0)` early-return (no `dunning_cycles` in `status='retrying'` with `next_retry_at <= now()`) emits its own `emitCronHeartbeat("dunning-payday-retry-cron", { produced: { status: "no_cycles_to_retry", processed: 0, results: [] } })` before returning, so a healthy hourly cron in a quiet dunning period reads green instead of tripping [[../libraries/control-tower]] monitor `never_fired`. The beat means "Inngest invoked me", not "there was work" — same fix as [[deliver-pending-send]], [[ticket-csat]], and [[abandoned-cart]] ([[../specs/cron-heartbeat-on-idle-tick]]).


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
