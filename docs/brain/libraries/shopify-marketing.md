# libraries/shopify-marketing

Email + SMS marketing consent mutations: `customerEmailMarketingConsentUpdate`, `customerSmsMarketingConsentUpdate`. Used by discount-signup journey + chargeback auto-unsubscribe.

**File:** `src/lib/shopify-marketing.ts`

## File header

```
Shopify marketing consent management
Subscribe/unsubscribe customers to email and SMS marketing
```

## Exports

### `subscribeToEmailMarketing` — function

```ts
async function subscribeToEmailMarketing(workspaceId: string, shopifyCustomerId: string,) : Promise<MarketingResult>
```

### `subscribeToSmsMarketing` — function

```ts
async function subscribeToSmsMarketing(workspaceId: string, shopifyCustomerId: string, phone?: string,) : Promise<MarketingResult>
```

### `unsubscribeFromEmailMarketing` — function

```ts
async function unsubscribeFromEmailMarketing(workspaceId: string, shopifyCustomerId: string,) : Promise<MarketingResult>
```

### `unsubscribeFromSmsMarketing` — function

```ts
async function unsubscribeFromSmsMarketing(workspaceId: string, shopifyCustomerId: string,) : Promise<MarketingResult>
```

### `unsubscribeFromAllMarketing` — function

```ts
async function unsubscribeFromAllMarketing(workspaceId: string, shopifyCustomerId: string,) : Promise<
```

### `subscribeToMarketing` — function

```ts
async function subscribeToMarketing(workspaceId: string, customerId: string, channels: ("email" | "sms")[],) : Promise<MarketingResult>
```

## Callers

- `src/app/api/journey/[token]/complete/route.ts`
- `src/app/api/webhooks/twilio/marketing-sms/route.ts`
- `src/lib/inngest/chargeback-processing.ts`
- `src/lib/inngest/fraud-detection.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
