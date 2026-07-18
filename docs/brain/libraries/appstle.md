# libraries/appstle

**Status:** Deprecated. M4 migrated dashboard + agent + AI to [[../libraries/commerce__subscription]]. M5 (2026-06-20) migrated portal surfaces to the Commerce SDK; legacy appstle.ts shims are preserved for backward compatibility but portal no longer calls them directly.

Legacy Appstle Subscriptions API client. Per-workspace API key + shop domain. Every helper checks `isInternalSubscription()` first and routes to `internal-subscription.ts` for internal subs. See [[../integrations/appstle]].

**File:** `src/lib/appstle.ts`

## Exports

### `resolveContractIdForAppstle` — function

```ts
async function resolveContractIdForAppstle(workspaceId: string, contractId: string): Promise<{ ok: true; contractId: string } | { ok: false; error: string }>
```

Guard-at-the-chokepoint UUID→shopify_contract_id resolver. If `contractId` is a bare Postgres UUID (i.e. `subscriptions.id`), swaps in the row's `shopify_contract_id` before any Appstle call — otherwise Appstle returns HTTP 400 with a NumberFormatException on `/subscription-contracts/{id}`. Detects UUID shape via `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`; non-UUID input passes through untouched. This prevents callers (playbook cancel, LLM-authored context, etc.) that pass our internal subscriptions.id UUID from hitting Appstle with invalid input and silently losing the cancel while the customer stays billed.

### `appstleSubscriptionAction` — function

```ts
async function appstleSubscriptionAction(workspaceId: string, contractId: string, action: "pause" | "cancel" | "resume", cancelReason?: string, cancelledBy?: string,) : Promise<{ success: boolean; error?: string }>
```

**UUID→shopify_contract_id swap at entry:** Calls `resolveContractIdForAppstle` at the top of the function (after the `isInternalSubscription` guard). If the resolve returns `ok: false`, returns `{ success: false, error: resolved.error }` instead of hitting Appstle with a UUID. This is the canonical chokepoint so all current and future callers benefit from the guard without re-implementing at each call site.

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

**Timeout recovery — both `504` and `upstream_timeout` branches verify.** When Appstle responds with HTTP 504 OR when [[appstle-call-log]] aborts the fetch at its 20s deadline (surfaced in the catch block as `Error('upstream_timeout')`), the helper calls the local `verifyBillingInterval(apiKey, contractId, interval, count)` reader against Appstle's contract-external endpoint. If the contract's `billingPolicy.interval` + `intervalCount` match what the customer requested, the timeout is treated as a **successful apply** — the local `subscriptions` row is updated (`billing_interval` + `billing_interval_count`) and `{ success: true }` is returned. Otherwise both paths return the same guarded message: `Request timed out and change could not be verified`. Non-timeout exceptions keep the existing `String(err)` behavior. The upstream_timeout branch mirrors the 504 recovery because the abort exists purely to stop portal Lambdas hanging until Vercel's 30s reap — Appstle occasionally writes the change but never replies, so the recovery is the same either way (signature `vercel:c0c26aa990d22744`).

### `appstleUpdateNextBillingDate` — function

```ts
async function appstleUpdateNextBillingDate(workspaceId: string, contractId: string, nextBillingDate: string, // YYYY-MM-DD or full ISO datetime) : Promise<
```

### `appstleGetUpcomingOrders` — function

```ts
async function appstleGetUpcomingOrders(workspaceId: string, contractId: string,) : Promise<
```

**JSON-id coercion at the boundary:** Appstle's `top-orders` endpoint returns each upcoming order's `id` as a JSON **number**, but our type signature and every downstream caller (dunning, portal order-now, `appstleAttemptBilling`'s `.startsWith` guard) treats it as a string. The helper maps each row through `String(o.id)` before returning, so every caller sees a consistent string id from the start (signature `vercel:c16ba1c31f84151b`).

### `appstleAttemptBilling` — function

```ts
async function appstleAttemptBilling(workspaceId: string, billingAttemptId: string,) : Promise<
```

**Defensive `String(...)` coercion:** Even though the parameter is typed as `string`, the helper wraps `billingAttemptId` with `String(...)` once at the top and uses the coerced value for the `startsWith` guard, the log message, and the URL interpolation. This makes the function type-safe regardless of upstream shape — previously, dunning passed `ordersRes.orders[0].id` straight through and Appstle's numeric JSON id tripped `TypeError: t.startsWith is not a function`, aborting every Appstle-billed retry and noising the Vercel error feed (signature `vercel:c16ba1c31f84151b`, also seen as `inngest:c800bfc534ae9a1e`). Belt-and-braces with the boundary coercion in `appstleGetUpcomingOrders` above.

**Internal-billing-attempt-id guard:** If the (coerced) id `startsWith("internal-")`, returns `{ success: true }` with a `console.warn` and **no Appstle API call**. Internal subs are Braintree-billed by the daily [[internal-subscription-renewals]] cron, not Appstle, but upstream callers (dunning payday-retry cron, new-card-recovery) synthesize a `internal-*` id into the billing-attempt slot. This early-return prevents the synthetic id from hitting Appstle's real API and 400-ing (signature vercel:cdfbac68e30a91f9), which would noise the error feed and Control Tower — see [[../specs/archive.d/dunning-payday-retry-skip-internal-subs]].

On a non-2xx/204 response (real Appstle attempts only) it returns the Appstle **response body** in `error` (mirrors `appstleSkipUpcomingOrder` / `appstleSubscriptionAction`) so callers can pattern-match instead of seeing a bare status string. When the upstream body matches *"billing operation is already in progress"* (Appstle's concurrency lock — meaning Appstle is ALREADY billing this contract), the helper logs at `console.warn` instead of `console.error` so the Vercel error feed / Control Tower stop capturing the benign race. [[portal__handlers__order-now]] keys off the same text to convert the response into a 200 with `alreadyBilling: true`.

It also downgrades a second benign-body class: Appstle `UserGeneratedError` responses that carry an "out of stock" message are upstream **business-condition rejections** (a line item ran out of stock between when dunning queued the attempt and when Appstle tried to charge), not server faults. The helper still returns `{ success: false, error: text }` so dunning rotation accounting is unchanged, but logs at `console.warn` so the Vercel error feed / Control Tower stop surfacing them as foreign-app noise.

### `orderNowByContract` — function

```ts
async function orderNowByContract(workspaceId: string, contractId: string,) : Promise<{ success: boolean; error?: string; summary?: string; internal?: boolean }>
```

**Flavor-aware "order now" / bill_now — the single entry point every *immediate* (on-demand) order-now path must use.** Resolves the sub by `shopify_contract_id`, then branches:
- **Internal sub** (`is_internal=true`): requires `status === "active"`, then fires `internal-subscription/renewal-attempt` ([[internal-subscription-renewals]]) via `inngest.send` → real Braintree charge → order → Avalara → Amplifier → advance `next_billing_date`. Returns `{ success: true, internal: true }`. Mirrors the portal handler ([[portal__handlers__order-now]]).
- **Appstle sub:** `appstleGetUpcomingOrders` → `appstleAttemptBilling`.

**Why it exists:** `appstleAttemptBilling`'s `internal-*` guard (above) is a NO-OP success — fine for the dunning cron (which drives the real internal renewal separately), but for on-demand order-now there's no cron follow-up, so calling appstle directly **silently drops the charge** (the bug that left an internal sub's "Order Now" reporting success while never billing — escalated ticket `dd67f3c7`, customer Angel). Callers funnelled through here: the ticket-UI bill-now route (`/api/workspaces/[id]/subscriptions/[subId]/bill-now`) and the AI executor's `bill_now` + `change_next_date` ASAP-fallback ([[action-executor]]). The appstle `internal-*` short-circuit stays in place as defense-in-depth for the dunning path.

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

**Portal-only** (M4 migrated internal surfaces to [[../libraries/commerce__subscription]]):
- `src/lib/portal/handlers/frequency.ts`
- `src/lib/portal/handlers/order-now.ts`
- `src/lib/portal/handlers/reactivate.ts`

**Inngest + crons** (use the shared internal-aware dispatcher):
- [[../inngest/portal-auto-resume]] — calls `appstleSubscriptionAction(..., "resume")` to resume paused subs, routing internal subs through local updates and Appstle subs through the Appstle API

## Gotchas

- Internal-sub guard everywhere — `isInternalSubscription()` short-circuits before any HTTP call.
- Cancel must use **DELETE** with `cancellationFeedback` + `cancellationNote` — PUT to PAUSED isn't a cancel.
- Cancel `cancelledBy` should be the operator's `display_name`, not their full name.

---

[[../README]] · [[../../CLAUDE]]
