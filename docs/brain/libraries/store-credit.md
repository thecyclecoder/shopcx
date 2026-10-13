# libraries/store-credit

Store credit issuance via Shopify `storeCreditAccountCredit`. Writes [[../tables/store_credit_log]].

> **Store credit auto-draws ONLY on charges WE initiate — never on a customer's self-placed web checkout.** A Shopify store-credit balance draws down automatically **only when the charge is one we bill on the customer's behalf — i.e. an Appstle subscription renewal.** A customer who self-checks-out on the website (a one-time web order) goes through a **separate Shopify checkout where the balance is NOT automatically applied** — that order is charged in full and the credit stays intact. So it is **NOT safe** to tell a customer "it will automatically come off your next order"; that is only true for an upcoming subscription renewal. **For a one-time/web order the customer must redeem it deliberately:** apply the store credit at checkout while logged into their Shopify account, or ask us to place an assisted order that draws the balance. Telling a credit-holding customer with **no subscription** that it "applies automatically, nothing to do" is false — for them it will never auto-apply to anything (ground truth: ticket `b26c64d2`, customer Joey DiGiano — $146.90 credit intact while his self-placed one-time order SC140050 was charged the full $98.16 with `discount_codes=[]`).

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

- **Self-placed one-time web orders do NOT draw store credit.** Store credit only draws down on charges we initiate (Appstle renewals). A customer self-checking-out on the website is a separate Shopify checkout — the balance is not applied and the order is charged in full (`discount_codes=[]`). Never tell a credit holder "nothing to do, it comes off automatically" unless the next charge is a subscription renewal; for a one-time/web order give the real redemption path (apply at checkout while logged in, or we place an assisted order). The orchestrator surfaces this alongside the `STORE CREDIT:` context line in `src/lib/sonnet-orchestrator-v2.ts`. Ground truth: ticket `b26c64d2` (SC140050).

---

[[../README]] · [[../../CLAUDE]]
