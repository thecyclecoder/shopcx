# inngest/sync-shopify

Main Shopify bulk sync — customers, orders, products via GraphQL Bulk Operations. Drives `import_jobs` progress.

**File:** `src/lib/inngest/sync-shopify.ts`

## Functions

### `sync-shopify-customers`
- **Trigger:** event `shopify/sync.customers`
- **Retries:** 3
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.workspace_id" }]`


### `sync-shopify-orders`
- **Trigger:** event `shopify/sync.orders`
- **Retries:** 3
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.workspace_id" }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/sync_jobs]]

## Tables read (not written)



---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
