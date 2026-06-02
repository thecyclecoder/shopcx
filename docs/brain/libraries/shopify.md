# libraries/shopify

OAuth URL builder, HMAC verifier, API version + scope constants. Shopify entry point. See [[../integrations/shopify]].

**File:** `src/lib/shopify.ts`

## Exports

### `generateNonce` — function

```ts
function generateNonce() : string
```

### `buildShopifyAuthUrl` — function

```ts
function buildShopifyAuthUrl({ shopDomain, clientId, redirectUri, state, }: { shopDomain: string; clientId: string; redirectUri: string; state: string; }) : string
```

### `verifyShopifyHmac` — function

```ts
function verifyShopifyHmac(query: Record<string, string>, clientSecret: string) : boolean
```

### `exchangeShopifyCode` — function

```ts
async function exchangeShopifyCode({ shop, clientId, clientSecret, code, }: { shop: string; clientId: string; clientSecret: string; code: string; }) : Promise<
```

### `fetchShopDetails` — function

```ts
async function fetchShopDetails(shop: string, accessToken: string) : Promise<
```

### `SHOPIFY_API_VERSION` — const

```ts
const SHOPIFY_API_VERSION
```

### `SHOPIFY_SCOPES` — const

```ts
const SHOPIFY_SCOPES
```

## Callers

- `src/app/api/customers/[id]/enrich/route.ts`
- `src/app/api/customers/[id]/payment-methods/route.ts`
- `src/app/api/loyalty/redeem/route.ts`
- `src/app/api/shopify/auth/route.ts`
- `src/app/api/shopify/callback/route.ts`
- `src/app/api/workspaces/[id]/coupons/route.ts`
- `src/app/api/workspaces/[id]/crisis/[crisisId]/coupon-lookup/route.ts`
- `src/app/api/workspaces/[id]/crisis/coupon-lookup/route.ts`
- `src/app/api/workspaces/[id]/orders/[orderId]/route.ts`
- `src/app/api/workspaces/[id]/returns/[returnId]/approve/route.ts`
- `src/app/api/workspaces/[id]/returns/[returnId]/decline/route.ts`
- `src/app/api/workspaces/[id]/sync-products/route.ts`
- `src/app/api/workspaces/[id]/widget-install/route.ts`
- `src/lib/dunning.ts`
- `src/lib/inngest/order-address-fallback.ts`
- `src/lib/inngest/sync-inventory.ts`
- `src/lib/marketing-coupons.ts`
- `src/lib/portal/handlers/loyalty-apply-subscription.ts`
- `src/lib/portal/handlers/loyalty-redeem.ts`
- `src/lib/replacement-order.ts`
- … and 13 more

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
