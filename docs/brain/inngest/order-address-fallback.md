# inngest/order-address-fallback

Async job: when an order arrives with null ship+bill addresses, pulls `Customer.defaultAddress` from Shopify and backfills. See feedback_address_mirror_rule.

**File:** `src/lib/inngest/order-address-fallback.ts`

## Functions

### `order-address-fallback`
- **Trigger:** event `orders/address-fallback`
- **Retries:** 3
- **Concurrency:** `concurrency: [{ limit: 5, key: "event.data.workspaceId" }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/orders]]

## Tables read (not written)



---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
