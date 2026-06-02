# libraries/integrations/braintree-customer

Braintree customer create / find helpers.

**File:** `src/lib/integrations/braintree-customer.ts`

## File header

```
Resolve (or create) the Braintree customer for a given shopcx
customer. Three-tier lookup so we never duplicate Braintree records:
1. Local DB  — customers.braintree_customer_id, if we've seen them before.
2. Braintree — search Braintree by email. Handles cases where a BT
customer exists from a prior code path / manual entry
/ a different shopcx workspace that already touched
this merchant.
3. Create    — new BT customer, stamp the id back onto our customers row.
Returns the resolved Braintree customer id. Throws if Braintree
isn't configured for the workspace.
Email is the dedup key. We don't try to dedup by phone — phone is
common across household members and we'd merge separate people.
```

## Exports

### `resolveBraintreeCustomerId` — function

```ts
async function resolveBraintreeCustomerId(input: ResolveInput,) : Promise<string>
```

### `savePaymentMethod` — function

```ts
async function savePaymentMethod(input: PaymentMethodSaveInput) : Promise<
```

### `vaultPaymentMethod` — function

```ts
async function vaultPaymentMethod(workspaceId: string, braintreeCustomerId: string, paymentMethodNonce: string, deviceData?: string,) : Promise<VaultResult>
```

### `PaymentMethodSaveInput` — interface

### `VaultResult` — interface

## Callers

- `src/app/api/checkout/client-token/route.ts`
- `src/app/api/checkout/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
