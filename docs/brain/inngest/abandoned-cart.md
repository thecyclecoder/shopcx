# inngest/abandoned-cart

Sweeps `cart_drafts` past `expires_at` → flips to `abandoned`. Hourly.

**File:** `src/lib/inngest/abandoned-cart.ts`

## Functions

### `abandoned-cart-reminder`
- **Trigger:** event `storefront/abandoned-cart.tick`
- **Concurrency:** `concurrency: [{ limit: 1 }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/cart_drafts]]

## Tables read (not written)

- [[../tables/customers]]
- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
