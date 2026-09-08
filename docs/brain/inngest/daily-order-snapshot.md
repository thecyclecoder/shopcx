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


## Validation against Shopify

Each day's snapshot cross-checks our DB against Shopify's own order count. The comparison is
**Shopify-origin orders only** (`shopify_order_id is not null`) — ShopCX-native orders
(`storefront`, `internal_subscription_renewal`, comp) are counted into `native_count` and excluded,
because Shopify structurally cannot see them. Comparing the full DB total flagged every day from
mid-2026 onward; see [[../tables/daily_order_snapshots]] § The mismatch check counts Shopify-origin
orders only.

`daily-order-snapshot-self-heal` (cron `0 12 * * *`) re-fires the snapshot event for any day
flagged in the **trailing 7 days**, so a day whose orders merely landed late is recomputed and
clears itself. A day still flagged after 7 days has aged out of that window and is a genuine
unrecovered gap — its dashboard card is the durable record. Exactly one card is raised per
(workspace, date).

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
