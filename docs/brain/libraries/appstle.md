# libraries/appstle

Appstle Subscriptions API client. Per-workspace API key + shop domain. Every helper checks `isInternalSubscription()` first and routes to `internal-subscription.ts` for internal subs. See [[../integrations/appstle]].

**File:** `src/lib/appstle.ts`

## Exports

### `appstleSubscriptionAction` — function

```ts
async function appstleSubscriptionAction(workspaceId: string, contractId: string, action: "pause" | "cancel" | "resume", cancelReason?: string, cancelledBy?: string,) : Promise<
```

On a non-2xx/204 response it returns the Appstle **response body** in `error` (`text || \`Appstle API error: ${status}\``), not a bare status string — mirroring `appstleSkipUpcomingOrder`. This is what lets [[portal__remediation]]'s `classifyPortalFailure` recognize a transient cancel 400 (e.g. *"billing operation is already in progress"* right after a renewal bills) and auto-retry/self-resolve instead of escalating a stale cancel ticket to a human.

### `appstleSkipNextOrder` — function

```ts
async function appstleSkipNextOrder(workspaceId: string, contractId: string,) : Promise<
```

### `appstleUpdateBillingInterval` — function

```ts
async function appstleUpdateBillingInterval(workspaceId: string, contractId: string, interval: "DAY" | "WEEK" | "MONTH" | "YEAR", intervalCount: number,) : Promise<
```

### `appstleUpdateNextBillingDate` — function

```ts
async function appstleUpdateNextBillingDate(workspaceId: string, contractId: string, nextBillingDate: string, // YYYY-MM-DD or full ISO datetime) : Promise<
```

### `appstleGetUpcomingOrders` — function

```ts
async function appstleGetUpcomingOrders(workspaceId: string, contractId: string,) : Promise<
```

### `appstleAttemptBilling` — function

```ts
async function appstleAttemptBilling(workspaceId: string, billingAttemptId: string,) : Promise<
```

### `appstleSkipUpcomingOrder` — function

```ts
async function appstleSkipUpcomingOrder(workspaceId: string, contractId: string,) : Promise<
```

### `appstleUnskipOrder` — function

```ts
async function appstleUnskipOrder(workspaceId: string, billingAttemptId: string,) : Promise<
```

### `appstleSwitchPaymentMethod` — function

```ts
async function appstleSwitchPaymentMethod(workspaceId: string, contractId: string, paymentMethodId: string,) : Promise<
```

### `appstleSendPaymentUpdateEmail` — function

```ts
async function appstleSendPaymentUpdateEmail(workspaceId: string, contractId: string,) : Promise<
```

### `appstleAddFreeProduct` — function

```ts
async function appstleAddFreeProduct(workspaceId: string, contractId: string, variantId: string, quantity: number = 1,) : Promise<
```

### `appstleSwapProduct` — function

```ts
async function appstleSwapProduct(workspaceId: string, contractId: string, oldVariantId: string, newVariantId: string,) : Promise<
```

## Callers

- `src/app/api/chargebacks/[id]/cancel-subscription/route.ts`
- `src/app/api/chargebacks/[id]/reinstate/route.ts`
- `src/app/api/workspaces/[id]/fraud-cases/[caseId]/cancel-subscription/route.ts`
- `src/app/api/workspaces/[id]/fraud-cases/[caseId]/confirm-fraud/route.ts`
- `src/app/api/workspaces/[id]/replacements/[replacementId]/route.ts`
- `src/app/api/workspaces/[id]/subscriptions/[subId]/bill-now/route.ts`
- `src/app/api/workspaces/[id]/subscriptions/[subId]/payment-update/route.ts`
- `src/app/api/workspaces/[id]/subscriptions/[subId]/route.ts`
- `src/lib/inngest/chargeback-processing.ts`
- `src/lib/inngest/dunning.ts`
- `src/lib/portal/handlers/frequency.ts`
- `src/lib/portal/handlers/order-now.ts`
- `src/lib/portal/handlers/reactivate.ts`

## Gotchas

- Internal-sub guard everywhere — `isInternalSubscription()` short-circuits before any HTTP call.
- Cancel must use **DELETE** with `cancellationFeedback` + `cancellationNote` — PUT to PAUSED isn't a cancel.
- Cancel `cancelledBy` should be the operator's `display_name`, not their full name.

---

[[../README]] · [[../../CLAUDE]]
