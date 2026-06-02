# libraries/identity-stitch

Anonymous-id + device-fingerprint backfill. See [[../lifecycles/storefront-checkout]] § Identity bootstrap.

**File:** `src/lib/identity-stitch.ts`

## File header

```
Identity stitching helpers.
Every time a visitor identifies themselves (lead capture, checkout
identify, full checkout submit, save-cart) we:
1. Read device + IP-geo from request headers (Vercel populates
x-vercel-ip-country/region/city; we never store raw IP).
2. If an anonymous_id is known (cart cookie / explicit body),
ensure a storefront_sessions row exists and stamp it with the
customer_id.
3. Backfill any storefront_events rows that share the anonymous_id
with the new customer_id so prior pre-identify activity attributes.
Steps 2-3 are no-ops when anonymous_id is missing (e.g. server-to-
server calls). The visitor enrichment happens regardless so we
always know "this customer was last seen from this device + region."
```

## Exports

### `readVisitorContext` — function

```ts
function readVisitorContext(request: Request) : VisitorContext
```

### `stitchVisitor` — function

```ts
async function stitchVisitor(opts: { workspaceId: string; customerId: string; anonymousId: string | null | undefined; context: VisitorContext; }) : Promise<void>
```

### `VisitorContext` — interface

## Callers

- `src/app/api/checkout/identify/route.ts`
- `src/app/api/checkout/route.ts`
- `src/app/api/lead/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
