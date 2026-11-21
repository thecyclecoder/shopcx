# inngest/journey-outcomes

Records journey outcomes onto tickets — fires `jo:positive` / `jo:negative` / `jo:neutral` tags.

**File:** `src/lib/inngest/journey-outcomes.ts`

## Functions

### `journey-session-completed`
- **Trigger:** event `journey/session.completed`
- **Retries:** 2
- **Win-back restart:** when the customer answered `reactivate_choice = reactivate` (or the outcome is `reactivated`) — see [[../libraries/reactivate-journey-builder]] `isReactivateChoice` — it resumes the target sub through the commerce SDK `subscriptionAction(resume)` (an Appstle-cancelled sub is rebuilt on ShopCX via `ensureShopcxEngine`). Target = `session.subscription_id`, else `resolveTargetSubscription` (the builder's own target: most recent cancelled/paused sub across linked accounts). Logs `customer_events` `winback.reactivated` / `winback.reactivate_failed`.
  - ⚠️ Gotcha (fixed 2026-11-21): the journey page posts `outcome:"completed"` for every multi-step journey, and win-back send scripts mint customer-only sessions (no `subscription_id`). The old `outcome === "reactivated"` + `session.subscription_id` gate meant the "Yes, restart" click never restarted anything.


### `journey-session-abandoned`
- **Trigger:** event `journey/session.abandoned`
- **Retries:** 1


## Downstream events sent

_None._

## Tables written

- [[../tables/customer_events]]
- [[../tables/customers]]
- [[../tables/journey_sessions]]
- [[../tables/subscriptions]]
- [[../tables/ticket_messages]]
- [[../tables/tickets]]

## Tables read (not written)



---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
