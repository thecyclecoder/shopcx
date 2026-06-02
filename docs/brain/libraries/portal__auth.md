# libraries/portal/auth

Shopify App Proxy HMAC-SHA256 verification + workspace resolution. Used by [[../integrations/shopify]] App Proxy on every portal call.

**File:** `src/lib/portal/auth.ts`

## File header

```
Shopify App Proxy HMAC-SHA256 signature verification
Ported from subscriptions-portal/lib/shopify/appProxy.ts + requireAppProxy.ts
```

## Exports

### `requireAppProxy` — function

```ts
async function requireAppProxy(req: NextRequest) : Promise<PortalAuthResult>
```

### `PortalAuthResult` — interface

## Callers

- `src/app/api/portal/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
