# libraries/shopify-customer-update

`customerUpdate` mutation for default address + email + phone updates.

**File:** `src/lib/shopify-customer-update.ts`

## File header

```
Update a Shopify customer's contact fields (phone / email /
first_name / last_name) via the GraphQL `customerUpdate` mutation.
Phone must be E.164. Email is validated by Shopify (returns
userErrors on bad format). We pass-through any provided field;
fields omitted from the input are left unchanged.
Returns { success, error?, shopifyErrors? }.
```

## Exports

### `updateShopifyCustomer` — function

```ts
async function updateShopifyCustomer(input: ShopifyCustomerUpdateInput) : Promise<ShopifyCustomerUpdateResult>
```

### `toE164US` — function

```ts
function toE164US(raw: string) : string | null
```

### `ShopifyCustomerUpdateInput` — interface

### `ShopifyCustomerUpdateResult` — interface

## Callers

_No internal callers found via static scan._

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
