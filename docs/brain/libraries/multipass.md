# libraries/multipass

Shopify Multipass SSO token generation for customer portal links.

**File:** `src/lib/multipass.ts`

## File header

```
Shopify Multipass token generation (Plus accounts only)
See: https://shopify.dev/docs/api/multipass
```

## Exports

### `generateMultipassToken` — function

```ts
function generateMultipassToken(multipassSecret: string, customerData: { email: string; return_to: string; created_at?: string },) : string
```

### `generateMultipassUrl` — function

```ts
function generateMultipassUrl(shop: string, multipassSecret: string, email: string, returnTo: string,) : string
```

## Callers

- `src/app/api/portal/multipass-login/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
