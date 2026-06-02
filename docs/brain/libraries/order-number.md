# libraries/order-number

Internal order number generator (e.g. `SC129467`). Uses workspace prefix + monotonic counter.

**File:** `src/lib/order-number.ts`

## File header

```
Workspace-scoped order number generator.
Native shopcx orders carry a "SHOPCX<N>" name (e.g. SHOPCX1, SHOPCX2)
to distinguish them from Shopify-imported orders (which use the
Shopify-assigned `SC<N>` shape).
Number scope: per workspace. SHOPCX1 in workspace A is unrelated to
SHOPCX1 in workspace B. Sequence is derived by max-and-increment
over existing SHOPCX-prefixed orders.
Concurrency note: two checkouts firing simultaneously in the same
workspace can collide. There's no unique constraint on order_number
yet — collisions just result in two orders with the same name. In
practice the window is tiny (single-digit milliseconds between read
and write) and the impact is cosmetic; a future hardening pass can
add a Postgres sequence or a (workspace_id, order_number) unique
index if it becomes a real problem.
```

## Exports

### `generateOrderNumber` — function

```ts
async function generateOrderNumber(workspaceId: string) : Promise<string>
```

## Callers

- `src/app/api/checkout/route.ts`
- `src/lib/inngest/internal-subscription-renewals.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
