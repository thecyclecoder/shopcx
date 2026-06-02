# inngest/crisis-campaign

Daily crisis-campaign cron. Finds eligible subs per active `crisis_events`, advances tiers, auto-swaps default flavor. Writes `crisis_customer_actions`. See CRISIS-MANAGEMENT-SPEC.md.

**File:** `src/lib/inngest/crisis-campaign.ts`

## Functions

### `crisis-daily-campaign`
- **Trigger:** event `crisis/run-campaign`
- **Concurrency:** `concurrency: [{ limit: 1 }]`


### `crisis-advance-tier`
- **Trigger:** event `crisis/tier-rejected`
- **Concurrency:** `concurrency: [{ limit: 5 }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/crisis_customer_actions]]
- [[../tables/journey_sessions]]
- [[../tables/ticket_messages]]
- [[../tables/tickets]]

## Tables read (not written)

- [[../tables/crisis_events]]
- [[../tables/customers]]
- [[../tables/journey_definitions]]
- [[../tables/subscriptions]]
- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
