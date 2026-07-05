# libraries/commerce__subscription

Canonical subscription mutation surface for the Commerce SDK. Every subscription operation flows through here with unified internal-vs-Appstle branching and healOnTouch guards.

**File:** `src/lib/commerce/subscription.ts`

**Status:** Ships with zero consumers (Phase 1 complete). Phase 3 wraps [[appstle]] and [[subscription-items]] in @deprecated shims pointing here; M4/M5 migrates callers. See [[../reference/commerce-sdk-inventory.html]] § Rename map for the full legacy→new pairing.

## Exports

### Status mutations

**`subscriptionAction`** — `async (workspaceId, contractId, action, cancelReason?, cancelledBy?) → OpResult`
- Branches on `isInternalSubscription()` → [[internal-subscription]]'s `internalSubscriptionAction` (internal Braintree flow) or [[appstle]]'s `appstleSubscriptionAction` (Appstle flow).
- Actions: `"pause"` | `"cancel"` | `"resume"`.
- Replaces `appstleSubscriptionAction`.

### Schedule mutations

**`subscriptionSkipNextOrder`** — `async (workspaceId, contractId) → OpResult`
- Branches on `isInternalSubscription()` → `internalSubSkipNextOrder` or `appstleSkipNextOrder`.
- Replaces `appstleSkipNextOrder`.

**`subscriptionUpdateBillingInterval`** — `async (workspaceId, contractId, interval, intervalCount) → OpResult`
- Branches on `isInternalSubscription()` → `internalSubUpdateBillingInterval` or `appstleUpdateBillingInterval`.
- Intervals: `"DAY"` | `"WEEK"` | `"MONTH"` | `"YEAR"`.
- Replaces `appstleUpdateBillingInterval`.

**`subscriptionUpdateNextBillingDate`** — `async (workspaceId, contractId, nextBillingDate) → OpResult`
- Branches on `isInternalSubscription()` → `internalSubUpdateNextBillingDate` or `appstleUpdateNextBillingDate`.
- Date format: YYYY-MM-DD or full ISO datetime.
- Replaces `appstleUpdateNextBillingDate`.

### Payment method mutations

**`subscriptionSwitchPaymentMethod`** — `async (workspaceId, contractId, paymentMethodId) → OpResult`
- Delegates to [[appstle]]'s `appstleSwitchPaymentMethod` (which internally handles both Braintree and Appstle paths).
- Top-guards with [[appstle-pricing]]'s `healOnTouch` on the Appstle branch.
- Replaces `appstleSwitchPaymentMethod`.

**`subscriptionSendPaymentUpdateEmail`** — `async (workspaceId, contractId) → OpResult`
- Delegates to [[appstle]]'s `appstleSendPaymentUpdateEmail`.
- Replaces `appstleSendPaymentUpdateEmail`.

### Line item mutations

**`subscriptionAddItem`** — `async (workspaceId, contractId, variantId, quantity=1) → OpResult`
- Delegates to [[subscription-items]]'s `subAddItem`.
- New consolidated name (was `subAddItem`).

**`subscriptionRemoveItem`** — `async (workspaceId, contractId, variantOrLine) → OpResult & { alreadyAbsent?: boolean }`
- Delegates to [[subscription-items]]'s `subRemoveItem`.
- Accepts variantId string or `{ variantId?, lineGid? }` object.
- New consolidated name (was `subRemoveItem`).

**`subscriptionChangeQuantity`** — `async (workspaceId, contractId, variantId, quantity) → OpResult`
- Delegates to [[subscription-items]]'s `subChangeQuantity`.
- New consolidated name (was `subChangeQuantity`).

**`subscriptionSwapVariant`** — `async (workspaceId, contractId, oldVariantId, newVariantId, quantity?) → OpResult`
- Delegates to [[subscription-items]]'s `subSwapVariant`.
- New consolidated name (was `subSwapVariant`).

**`subscriptionUpdateLineItemPrice`** — `async (workspaceId, contractId, variantId, basePriceCents, lineGid?) → OpResult`
- Delegates to [[subscription-items]]'s `subUpdateLineItemPrice`.
- **0.75 SubSave multiplier baked in** — pass the visible customer price; the function shifts to post-SubSave contract price.
- New consolidated name (was `subUpdateLineItemPrice`).

### Product mutations

**`subscriptionAddFreeProduct`** — `async (workspaceId, contractId, variantId, quantity=1) → OpResult`
- Delegates to [[appstle]]'s `appstleAddFreeProduct`.
- Replaces `appstleAddFreeProduct`.

**`subscriptionSwapProduct`** — `async (workspaceId, contractId, oldVariantId, newVariantId) → OpResult`
- Delegates to [[appstle]]'s `appstleSwapProduct`.
- Replaces `appstleSwapProduct`.

### Billing & order

**`subscriptionAttemptBilling`** — `async (workspaceId, billingAttemptId) → OpResult`
- Delegates to [[appstle]]'s `appstleAttemptBilling`.
- **Internal-billing-attempt-id guard:** If `billingAttemptId.startsWith("internal-")`, returns `{ success: true }` with no Appstle API call. Internal subs are Braintree-billed by the daily [[../inngest/internal-subscription-renewals]] cron; upstream callers (dunning payday-retry, new-card-recovery) synthesize synthetic `internal-*` ids. The guard prevents 400-ing the real API — see [[../specs/archive.d/dunning-payday-retry-skip-internal-subs]].
- Replaces `appstleAttemptBilling`.

**`subscriptionOrderNow`** — `async (workspaceId, contractId) → { success, error?, internal? }`
- **Flavor-aware "order now" — the single entry point for on-demand immediate billing.** Resolves by `shopify_contract_id`, then branches:
  - **Internal sub** (`is_internal=true`): requires `status === "active"`, fires [[../inngest/internal-subscription-renewals]] via `inngest.send` → real Braintree charge → order → Avalara → Amplifier → advance `next_billing_date`. Returns `{ success: true, internal: true }`.
  - **Appstle sub:** `appstleGetUpcomingOrders` → `appstleAttemptBilling`.
- **Why it exists:** `appstleAttemptBilling`'s `internal-*` guard is a NO-OP success — fine for dunning cron (real renewal follows separately), but for on-demand order-now with no cron follow-up, calling Appstle directly **silently drops the charge** (the bug that left internal sub's "Order Now" reporting success while never billing — ticket `dd67f3c7`, customer Angel). Replaces the fragmented path.

### Types

**`export type { SubscriptionView, SubscriptionLineView, SubscriptionPricingView }`**
- Re-exported from [[./types]] (commerce SDK internal type set).

## Pattern: Internal-vs-Appstle branching

Every mutation checks `isInternalSubscription()` at the top:
- **Internal path:** delegates to `internal*` handlers from [[internal-subscription]] (Braintree charge, internal state management).
- **Appstle path:** delegates to `appstleX` wrappers from [[appstle]] (Appstle API + healOnTouch top-guard from [[appstle-pricing]]).

This keeps the internal-subscription + Appstle billing logic isolated in their respective modules while presenting a unified surface to callers. Callers never decide whether to call internal or Appstle — they call the subscription* function and the SDK branches on the actual sub type.

## Migration path

Phase 3 (in-flight) wraps the old exports in [[appstle]] and [[subscription-items]] with thin @deprecated shims that delegate to these new surface functions:
```ts
// src/lib/appstle.ts (Phase 3)
export async function appstleSubscriptionAction(...) {
  return subscriptionAction(...);  // @deprecated — use subscriptionAction from commerce SDK
}
```

Callers on the old names continue to work until M4/M5 migrate them to the new surface. The old modules' pages are updated to note the deprecation; this page is the new authoritative reference.

## See also

[[../reference/commerce-sdk-inventory.html]] — Rename map (old→new pairings), defect register, and full SDK structure.
[[appstle]] — Appstle API client (now called via this surface).
[[subscription-items]] — Line item mutations (now called via this surface).
[[internal-subscription]] — Internal (Braintree) billing path (now called via this surface).
[[appstle-pricing]] — healOnTouch guards (applied by the Appstle paths).
