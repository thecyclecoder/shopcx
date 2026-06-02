# inngest/delivery-audit

Audits EasyPost-tracked orders that are stuck (in_transit too long) — surfaces in `dashboard_notifications`.

**File:** `src/lib/inngest/delivery-audit.ts`

## Functions

### `delivery-nightly-audit`
- **Trigger:** cron `0 11 * * *`
- **Concurrency:** `concurrency: [{ limit: 1 }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/dashboard_notifications]]
- [[../tables/orders]]
- [[../tables/ticket_messages]]
- [[../tables/tickets]]

## Tables read (not written)

- [[../tables/playbooks]]
- [[../tables/subscriptions]]
- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
