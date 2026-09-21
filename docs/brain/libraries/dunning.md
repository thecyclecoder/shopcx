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

### `triggerNewCardRecovery` — function

```ts
async function triggerNewCardRecovery(workspaceId: string, customerId: string, braintreePaymentMethodToken: string,) : Promise<{ fired: boolean; cycleCount: number }>
```

Initiates recovery for any open dunning cycles on a customer when they add or update a payment method on the storefront or portal (via Braintree). Best-effort and idempotent — never throws or fails the card-add operation, and the event handler is serialized per customer to prevent double-charges. Called from `src/app/api/checkout/payment-methods/route.ts` after successful card vault. (Phase 2 of [[../specs/a-dunning-cycle-must-never-silently-strand-a-subscription]] — 2026-09-21.)

### `createDunningCycle` — function

```ts
async function createDunningCycle(workspaceId: string, shopifyContractId: string, subscriptionId: string | null, customerId: string | null, billingAttemptId: string | null,) : Promise<
```

### `updateDunningCycle` — function

```ts
async function updateDunningCycle(cycleId: string, updates: Record<string, unknown>,) : Promise<boolean>
```

Updates a dunning cycle row. Returns `true` on success, `false` on write failure. On error, logs a line containing the literal string `updateDunningCycle failed` (including the cycle id and error message) so silent failures on money-adjacent ledgers are visible. (Phase 4 of [[../specs/a-dunning-cycle-must-never-silently-strand-a-subscription]] — 2026-09-21.)

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

### `RECOVERABLE_DUNNING_STATUSES` — constant

```ts
const RECOVERABLE_DUNNING_STATUSES = [...OPEN_DUNNING_STATUSES, "exhausted"]
```

The set of dunning cycle statuses that are eligible for recovery when a customer adds a new payment method. Includes `active`, `rotating`, `retrying`, `skipped`, and `exhausted` (so a dunning-CANCELLED sub reactivates). Does NOT include cycles with a `closed_reason` set (which means the customer paused/cancelled the subscription, not dunning — these must never be resurrected). Used by the recovery-gate check in [[dunning-webhook]] and by [[../libraries/dunning-strand-detector]]. (Phase 3 of [[../specs/a-dunning-cycle-must-never-silently-strand-a-subscription]] — 2026-09-21.)

### `PaymentMethod` — interface

### `DunningSettings` — interface

## Callers

- `src/app/api/webhooks/appstle/[workspaceId]/route.ts` — failure capture
- `src/app/api/checkout/payment-methods/route.ts` — card-add recovery (Phase 2)
- `src/lib/inngest/dunning.ts` — orchestration

## Gotchas

- Card dedup is by `(last4, expiry_month, expiry_year, card_brand)` — Shopify can return multiple `paymentMethodToken`s for the same logical card.
- Terminal error codes (`card_blocked`, `do_not_honor`) short-circuit card rotation.
- Appstle's built-in retries + skip-after-X must be OFF — otherwise our pipeline + Appstle's will fight.
- `RECOVERABLE_DUNNING_STATUSES` and `getActiveDunningCyclesForCustomer` **must use the same list** — the recovery-gate guard and the handler both depend on consistent status tracking. See [[../lifecycles/dunning]] § Phase 5.

## Related

[[../libraries/dunning-strand-detector]] — Safety detector for contract drift and overdue-but-active subscriptions (Phase 5 of [[../specs/a-dunning-cycle-must-never-silently-strand-a-subscription]] — 2026-09-21).

---

[[../README]] · [[../../CLAUDE]]
