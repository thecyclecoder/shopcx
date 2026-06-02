# libraries/shipping-rates

Storefront shipping rate resolution per (region, weight).

**File:** `src/lib/shipping-rates.ts`

## File header

```
Shipping rates — server-side pricing.
Rates live in `shipping_rates`, keyed by (workspace_id, code,
applies_to). Pricing is `base_cents + per_item_cents * chargeable_units`
capped at `max_total_cents`. Freebies (unit_price_cents = 0) don't
count toward `chargeable_units` so we never upcharge shipping for a
promotional add-on.
`applies_to` follows the cart: if any line is `mode='subscribe'` the
cart counts as subscription for shipping. Mixed carts fall under
subscription rates because the subscribing item dominates the
fulfillment cadence.
```

## Exports

### `appliesToFor` — function

```ts
function appliesToFor(lines: LineLike[]) : ShippingAppliesTo
```

### `chargeableUnits` — function

```ts
function chargeableUnits(lines: LineLike[]) : number
```

### `priceRate` — function

```ts
function priceRate(rate: ShippingRate, units: number) : number
```

### `listRatesForCart` — function

```ts
async function listRatesForCart(workspaceId: string, lines: LineLike[],) : Promise<PricedRate[]>
```

### `getRateById` — function

```ts
async function getRateById(rateId: string) : Promise<ShippingRate | null>
```

### `resolveRateForCart` — function

```ts
async function resolveRateForCart(workspaceId: string, lines: LineLike[], requestedCode: string | null | undefined,) : Promise<
```

### `ShippingRate` — interface

### `PricedRate` — interface

### `ShippingAppliesTo` — type

## Callers

- `src/app/api/checkout/route.ts`
- `src/app/api/checkout/shipping-rates/route.ts`
- `src/app/api/checkout/tax-quote/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
