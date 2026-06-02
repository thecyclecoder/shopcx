# inngest/daily-order-snapshot

Daily rollup → `daily_order_snapshots`. Drives the home dashboard charts.

**File:** `src/lib/inngest/daily-order-snapshot.ts`

## Functions

### `daily-order-snapshot-self-heal`
- **Trigger:** cron `0 12 * * *`


### `daily-order-snapshot`
- **Trigger:** event `snapshot/daily-orders`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 1 }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/daily_order_snapshots]]
- [[../tables/dashboard_notifications]]

## Tables read (not written)

- [[../tables/orders]]
- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
