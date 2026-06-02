# libraries/crisis-journey-builder

Per-tier crisis journey builders (Tier 1 flavor swap, Tier 2 product swap, Tier 3 pause/remove).

**File:** `src/lib/crisis-journey-builder.ts`

## File header

```
Crisis Journey Builder — builds steps for crisis tier journeys.
Tier 1: Flavor swap (single choice from available_flavor_swaps)
Tier 2: Product swap + coupon (single choice from available_product_swaps, then quantity)
Tier 3: Pause/remove (berry_only → pause vs cancel, berry_plus → remove vs cancel)
```

## Exports

### `buildCrisisTier1Steps` — function

```ts
async function buildCrisisTier1Steps(admin: Admin, workspaceId: string, customerId: string, ticketId: string,) : Promise<BuiltJourneyConfig>
```

### `buildCrisisTier2Steps` — function

```ts
async function buildCrisisTier2Steps(admin: Admin, workspaceId: string, customerId: string, ticketId: string,) : Promise<BuiltJourneyConfig>
```

### `buildCrisisTier3Steps` — function

```ts
async function buildCrisisTier3Steps(admin: Admin, workspaceId: string, customerId: string, ticketId: string,) : Promise<BuiltJourneyConfig>
```

## Callers

_No internal callers found via static scan._

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
