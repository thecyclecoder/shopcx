# inngest/refresh-customer-segments

Recomputes `customers.segments` array for archetype-driven SMS targeting. See PERPETUAL-CAMPAIGNS-SPEC.md.

**File:** `src/lib/inngest/refresh-customer-segments.ts`

## Functions

### `refresh-customer-segments-cron`
- **Trigger:** cron `0 11 * * *`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 1 }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/customers]]

## Tables read (not written)

- [[../tables/orders]]
- [[../tables/profile_events]]
- [[../tables/subscriptions]]
- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
