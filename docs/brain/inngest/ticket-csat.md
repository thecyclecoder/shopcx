# inngest/ticket-csat

Sends CSAT survey 24h after a ticket closes. Writes `tickets.csat_score` on response.

**File:** `src/lib/inngest/ticket-csat.ts`

## Functions

### `ticket-csat`
- **Trigger:** event `ticket/closed`
- **Retries:** 2


## Downstream events sent

_None._

## Tables written

_None._

## Tables read (not written)

- [[../tables/customers]]
- [[../tables/tickets]]
- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
