# inngest/journey-outcomes

Records journey outcomes onto tickets — fires `jo:positive` / `jo:negative` / `jo:neutral` tags.

**File:** `src/lib/inngest/journey-outcomes.ts`

## Functions

### `journey-session-completed`
- **Trigger:** event `journey/session.completed`
- **Retries:** 2


### `journey-session-abandoned`
- **Trigger:** event `journey/session.abandoned`
- **Retries:** 1


## Downstream events sent

_None._

## Tables written

- [[../tables/customers]]
- [[../tables/journey_sessions]]
- [[../tables/subscriptions]]
- [[../tables/ticket_messages]]
- [[../tables/tickets]]

## Tables read (not written)



---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
