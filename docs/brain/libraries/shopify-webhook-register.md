# libraries/shopify-webhook-register

Registers Shopify webhook subscriptions per workspace on connect.

**File:** `src/lib/shopify-webhook-register.ts`

## Exports

### `registerShopifyWebhooks` — function

```ts
async function registerShopifyWebhooks(shop: string, accessToken: string, callbackUrl: string) : Promise<
```

## Callers

- `src/app/api/shopify/callback/route.ts`
- `src/app/api/workspaces/[id]/integrations/shopify/webhooks/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
