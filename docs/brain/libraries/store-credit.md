# libraries/store-credit

Store credit issuance via Shopify `storeCreditAccountCredit`. Writes [[../tables/store_credit_log]].

> **Store credit auto-applies to the customer's next charge.** Once issued, a Shopify store-credit balance is automatically used against the customer's next order — **whether that's an Appstle subscription renewal or a one-time order**. Nothing to "apply" manually; it draws down on the next charge. Safe to tell a customer "this $X credit will automatically come off your next order."

**File:** `src/lib/store-credit.ts`

## Exports

### `issueStoreCredit` — function

```ts
async function issueStoreCredit(params: StoreCreditParams) : Promise<StoreCreditResult>
```

### `debitStoreCredit` — function

```ts
async function debitStoreCredit(params: StoreCreditParams) : Promise<StoreCreditResult>
```

### `getStoreCreditBalance` — function

```ts
async function getStoreCreditBalance(workspaceId: string, shopifyCustomerId: string,) : Promise<
```

### `getStoreCreditHistory` — function

```ts
async function getStoreCreditHistory(workspaceId: string, customerId: string,) : Promise<StoreCreditLogEntry[]>
```

### `StoreCreditParams` — interface

### `StoreCreditResult` — interface

### `StoreCreditLogEntry` — interface

## Callers

- `src/app/api/store-credit/balance/route.ts`
- `src/app/api/store-credit/debit/route.ts`
- `src/app/api/store-credit/history/route.ts`
- `src/app/api/store-credit/issue/route.ts`
- `src/lib/ai-context.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
