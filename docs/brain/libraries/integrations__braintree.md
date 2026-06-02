# libraries/integrations/braintree

Braintree gateway client. `getBraintreeGateway()`, `refundBraintreeTransaction()`. See [[../integrations/braintree]].

**File:** `src/lib/integrations/braintree.ts`

## File header

```
Per-workspace Braintree gateway access.
Credentials live on the workspaces row (4 columns added in
20260519200000_workspaces_braintree.sql). The private key is
AES-256-GCM encrypted; everything else is plaintext.
getBraintreeGateway(workspaceId)     Resolve a ready-to-use BraintreeGateway.
verifyBraintreeCredentials(...)      Smoke-test creds before saving.
Gateway instances are cached per-workspace for 5 minutes — the
Braintree SDK keeps a connection pool internally so reusing the
same gateway is cheaper than reconstructing it on every request.
```

## Exports

### `loadBraintreeConfig` — function

```ts
async function loadBraintreeConfig(workspaceId: string) : Promise<BraintreeConfig>
```

### `getBraintreeGateway` — function

```ts
async function getBraintreeGateway(workspaceId: string) : Promise<braintree.BraintreeGateway>
```

### `invalidateBraintreeCache` — function

```ts
function invalidateBraintreeCache(workspaceId: string) : void
```

### `refundBraintreeTransaction` — function

```ts
async function refundBraintreeTransaction(workspaceId: string, transactionId: string, amountCents?: number,) : Promise<
```

### `findBraintreeTransactionByMetadata` — function

```ts
async function findBraintreeTransactionByMetadata(workspaceId: string, args: { email: string; amountDecimal: string; processedAt: string },) : Promise<
```

### `verifyBraintreeCredentials` — function

```ts
async function verifyBraintreeCredentials(config: BraintreeConfig,) : Promise<
```

### `BraintreeConfig` — interface

## Callers

- `src/app/api/checkout/client-token/route.ts`
- `src/app/api/checkout/route.ts`
- `src/app/api/workspaces/[id]/integrations/braintree/verify/route.ts`
- `src/lib/inngest/internal-subscription-renewals.ts`
- `src/lib/integrations/braintree-customer.ts`
- `src/lib/shopify-order-actions.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
