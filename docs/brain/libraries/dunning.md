# libraries/dunning

Core dunning logic: card dedup, payday scheduling, settings, cycle CRUD, error-code categorization. See [[../lifecycles/dunning]].

**File:** `src/lib/dunning.ts`

## File header

```
Core dunning logic: card rotation, payment method dedup, payday scheduling
```

## Exports

### `getCustomerPaymentMethods` — function

```ts
async function getCustomerPaymentMethods(workspaceId: string, shopifyCustomerId: string,) : Promise<PaymentMethod[]>
```

Fetches live payment methods from Shopify GraphQL with automatic retry-on-5xx/429/network transients (3 retries, 1-2s backoff). A one-off Shopify upstream 503 is absorbed at the fetch boundary instead of surfacing as "zero payment methods" → exhausted dunning cycle. Mirrors `fetchWithRetry` from [[shopify-sync]]. Only throws after all retries exhausted.

### `syncShopifyPaymentMethods` — function

```ts
async function syncShopifyPaymentMethods(workspaceId: string, customerId: string, shopifyCustomerId: string,) : Promise<{ synced: number }>
```

Mirrors a customer's live Shopify cards into [[../tables/customer_payment_methods]] as `provider='shopify'` rows (check-then-write, keyed on `shopify_payment_method_id`). Called from the payment-method webhook ([[dunning-webhook]]). First card becomes default if the customer has none. See [[../lifecycles/dunning]] Phase 5.

### `deduplicatePaymentMethods` — function

```ts
function deduplicatePaymentMethods(methods: PaymentMethod[]) : PaymentMethod[]
```

### `getUntriedCards` — function

```ts
function getUntriedCards(methods: PaymentMethod[], triedCards: string[],) : PaymentMethod[]
```

### `getNextPaydayDates` — function

```ts
function getNextPaydayDates(fromDate: Date, count: number) : Date[]
```

### `getRetryTime` — function

```ts
function getRetryTime(paydayDate: Date, timezoneOffset: number = -6) : Date
```

### `getDunningSettings` — function

```ts
async function getDunningSettings(workspaceId: string) : Promise<DunningSettings | null>
```

### `getActiveDunningCycle` — function

```ts
async function getActiveDunningCycle(workspaceId: string, shopifyContractId: string,) : Promise<
```

### `getActiveDunningCyclesForCustomer` — function

```ts
async function getActiveDunningCyclesForCustomer(workspaceId: string, customerId: string,) : Promise<
```

### `createDunningCycle` — function

```ts
async function createDunningCycle(workspaceId: string, shopifyContractId: string, subscriptionId: string | null, customerId: string | null, billingAttemptId: string | null,) : Promise<
```

### `updateDunningCycle` — function

```ts
async function updateDunningCycle(cycleId: string, updates: Record<string, unknown>,) : Promise<void>
```

### `logPaymentFailure` — function

```ts
async function logPaymentFailure(params: { workspaceId: string; customerId: string | null; subscriptionId: string | null; shopifyContractId: string; billingAttemptId?: string | null; paymentMethodLast4?: string | null; paymentMethodId?: string | null; errorCode?: string | null; errorMessage?: string | null; attemptNumber: number; attemptType: "initial" | "card_rotation" | "payday_retry" | "new_card_retry"; succeeded: boolean; }) : Promise<void>
```

### `getLastSuccessfulCard` — function

```ts
async function getLastSuccessfulCard(workspaceId: string, customerId: string,) : Promise<
```

### `isTerminalErrorCode` — function

```ts
async function isTerminalErrorCode(workspaceId: string, errorCode: string | null,) : Promise<boolean>
```

### `trackErrorCode` — function

```ts
async function trackErrorCode(workspaceId: string, errorCode: string | null, errorMessage: string | null,) : Promise<void>
```

### `dunningInternalNote` — function

```ts
function dunningInternalNote(message: string) : string
```

### `postDunningNoteOnTicket` — function

```ts
async function postDunningNoteOnTicket(workspaceId: string, customerId: string | null, note: string,) : Promise<void>
```

### `tagOpenTickets` — function

```ts
async function tagOpenTickets(workspaceId: string, customerId: string | null, tag: string,) : Promise<void>
```

### `cancelForTerminalNoBackup` — function

```ts
async function cancelForTerminalNoBackup(params: { workspaceId: string; contractId: string; customerId: string | null; errorCode: string; errorMessage: string | null; paymentMethodCount: number; }) : Promise<void>
```

### `PaymentMethod` — interface

### `DunningSettings` — interface

## Callers

- `src/app/api/webhooks/appstle/[workspaceId]/route.ts`
- `src/lib/inngest/dunning.ts`

## Gotchas

- Card dedup is by `(last4, expiry_month, expiry_year, card_brand)` — Shopify can return multiple `paymentMethodToken`s for the same logical card.
- Terminal error codes (`card_blocked`, `do_not_honor`) short-circuit card rotation.
- Appstle's built-in retries + skip-after-X must be OFF — otherwise our pipeline + Appstle's will fight.

---

[[../README]] · [[../../CLAUDE]]
