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

Short-circuits no-op requests: if the local `subscriptions.billing_interval` + `billing_interval_count` already match the requested values, returns `{ success: true }` without calling Appstle. Same-value submissions previously hit Appstle's billing-policy validator and surfaced as recurring noise on the Vercel error feed / Control Tower (signature `vercel:09366492567e0fde`, fixed by [[../specs/archive.d/appstle-frequency-update-noop-guard]]). Customer intent (frequency = X) is satisfied without the API round-trip.

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

**Internal-billing-attempt-id guard:** If `billingAttemptId.startsWith("internal-")`, returns `{ success: true }` with a `console.warn` and **no Appstle API call**. Internal subs are Braintree-billed by the daily [[internal-subscription-renewals]] cron, not Appstle, but upstream callers (dunning payday-retry cron, new-card-recovery) synthesize a `internal-*` id into the billing-attempt slot. This early-return prevents the synthetic id from hitting Appstle's real API and 400-ing (signature vercel:cdfbac68e30a91f9), which would noise the error feed and Control Tower — see [[../specs/archive.d/dunning-payday-retry-skip-internal-subs]].

On a non-2xx/204 response (real Appstle attempts only) it returns the Appstle **response body** in `error` (mirrors `appstleSkipUpcomingOrder` / `appstleSubscriptionAction`) so callers can pattern-match instead of seeing a bare status string. When the upstream body matches *"billing operation is already in progress"* (Appstle's concurrency lock — meaning Appstle is ALREADY billing this contract), the helper logs at `console.warn` instead of `console.error` so the Vercel error feed / Control Tower stop capturing the benign race. [[portal__handlers__order-now]] keys off the same text to convert the response into a 200 with `alreadyBilling: true`.

It also downgrades a second benign-body class: Appstle `UserGeneratedError` responses that carry an "out of stock" message are upstream **business-condition rejections** (a line item ran out of stock between when dunning queued the attempt and when Appstle tried to charge), not server faults. The helper still returns `{ success: false, error: text }` so dunning rotation accounting is unchanged, but logs at `console.warn` so the Vercel error feed / Control Tower stop surfacing them as foreign-app noise.

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

Recognizes Appstle's billing-cycle-contract-edit guardrail (`400 UserGeneratedError` with body containing *"billing cycle contract edit"*). When Appstle has a contract edit in flight it refuses concurrent payment-method switches; this is an expected, user-generated transient — NOT a server fault — so the helper logs at `console.warn` (Vercel error feed / Control Tower stop surfacing it) and returns `{ success: false, error: "contract_edit_in_progress" }` so callers can retry instead of seeing a bare status string. Mirrors the recognizer shape in `appstleRemoveLineItem` ([[subscription-items]]).

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
