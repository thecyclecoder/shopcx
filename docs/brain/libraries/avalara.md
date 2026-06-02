# libraries/avalara

Sales tax client. Quote (SalesOrder) + commit (SalesInvoice) + void. See [[../integrations/avalara]].

**File:** `src/lib/avalara.ts`

## File header

```
Avalara (AvaTax) client. Used by the new custom storefront checkout
+ the in-house subscription scheduler to calculate sales tax and
report committed sales for filing.
Auth: Basic, account_id as username + license key as password.
Environment: sandbox-rest.avatax.com (testing) or rest.avatax.com (prod).
Two-phase pattern for a checkout:
1. createTransaction({ commit: false }) — at order-review step, get
authoritative tax to display + charge.
2. createTransaction({ commit: true }) — after payment success, lock
in the transaction in Avalara for filing. Same `code` (our order
ID) → idempotent.
For refunds: refundTransaction({ code, refundType, lines }).
For voids: voidTransaction({ code }) — only useful before the sale
settles / before Avalara files.
```

## Exports

### `createTransaction` — function

```ts
async function createTransaction(workspaceId: string, params: CreateTransactionParams,) : Promise<CreateTransactionResult>
```

### `voidTransaction` — function

```ts
async function voidTransaction(workspaceId: string, transactionCode: string,) : Promise<
```

### `refundTransaction` — function

```ts
async function refundTransaction(workspaceId: string, params: { transactionCode: string; refundCode: string; // new code for the refund tx (e.g., "REFUND-SC131727-001") date: string; // ISO date refundType: "Full" | "Partial" | "TaxOnly" | "Percentage"; refundPercentage?: number; refundLines?: string[]; // line numbers to refund (Partial only) },) : Promise<
```

### `pingAvalara` — function

```ts
async function pingAvalara(accountId: string, licenseKey: string, environment: "sandbox" | "production",) : Promise<
```

### `AvalaraAddress` — interface

### `AvalaraLineItem` — interface

### `CreateTransactionParams` — interface

### `CreateTransactionResult` — interface

## Callers

- `src/app/api/checkout/route.ts`
- `src/app/api/checkout/tax-quote/route.ts`
- `src/app/api/workspaces/[id]/integrations/avalara/verify/route.ts`
- `src/lib/avalara-cart.ts`
- `src/lib/avalara-subscription.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
