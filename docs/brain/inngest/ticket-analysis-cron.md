# inngest/ticket-analysis-cron

Nightly cron that runs `ticket-analyzer.ts` over recent tickets → `ticket_analyses`.

**File:** `src/lib/inngest/ticket-analysis-cron.ts`

## Functions

### `ticket-analysis-cron`
- **Trigger:** cron `*/30 * * * *`
- **Retries:** 1
- **Control Tower heartbeat:** calls `emitCronHeartbeat("ticket-analysis-cron", …)` at the END of **every** run — including the no-tickets idle path (`if (!tickets.length)`). Required because `*/30` against a 90-min liveness window means a few consecutive empty runs would otherwise emit no `loop_heartbeats` row and `control-tower-monitor` would false-flag the healthy quiet cron as dead (signature `loop:ticket-analysis-cron`). Mirrors the empty-path heartbeat in [[ticket-csat]], [[deliver-pending-send]], [[abandoned-cart]]. See [[../libraries/control-tower]].


## Downstream events sent

_None._

## Tables written

- [[../tables/tickets]]

## Tables read (not written)



---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
