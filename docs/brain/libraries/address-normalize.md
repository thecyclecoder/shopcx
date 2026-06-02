# libraries/address-normalize

Lowercase + strip punctuation + expand street suffixes. Used by fraud detection address comparison + EasyPost shipment building.

**File:** `src/lib/address-normalize.ts`

## File header

```
Address normalization for fraud detection.
Standardizes addresses so "123 Main St Apt 2" matches "123 main street #2".
```

## Exports

### `normalizeAddress` — function

```ts
function normalizeAddress(address: { address1?: string | null; address2?: string | null; city?: string | null; province?: string | null; zip?: string | null; country?: string | null; } | null) : string | null
```

### `normalizeShopifyShippingAddress` — function

```ts
function normalizeShopifyShippingAddress(shippingAddress: Record<string, unknown> | null | undefined) : string | null
```

### `shopifyAddressToSnake` — function

```ts
function shopifyAddressToSnake(addr: Record<string, unknown> | null | undefined) : Record<string, unknown> | null
```

### `resolveOrderAddresses` — function

```ts
function resolveOrderAddresses(rawShipping: Record<string, unknown> | null | undefined, rawBilling: Record<string, unknown> | null | undefined, customerDefault?: Record<string, unknown> | null | undefined,) :
```

## Callers

- `src/lib/shopify-sync.ts`
- `src/lib/shopify-webhooks.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
