# libraries/commerce__subscription

The single subscription-mutation surface in the [[commerce-sdk-inventory|Centralized Commerce SDK]]. Every subscription mutation flows through here as one canonical `subscriptionX` op set (renaming the current `appstleX` + `subX` exports). Each op branches on `isInternalSubscription()` from [[internal-subscription]] — internal → the `internalSub*` handlers; else → the existing [[appstle]] / [[subscription-items]] wrappers, which top-guard with `healOnTouch` from [[appstle-pricing]] and handle the Appstle boundary.

**File:** `src/lib/commerce/subscription.ts`

Ships with zero consumers. M2/Phase 3 flips the `appstleX` / `subX` exports to thin `@deprecated` shims that call the ops below; M4/M5 migrates callers off the shims. Full pairing: see [[../reference/commerce-sdk-inventory#rename-map|commerce-sdk-inventory § Rename map]].

## Exports

Every op returns `{ success: boolean; error?: string }` (plus op-specific fields where noted).

### Status

- `subscriptionAction(workspaceId, contractId, action: "pause" | "cancel" | "resume", cancelReason?, cancelledBy?)` — pause / resume / cancel dispatch. Internal → [[internal-subscription#internalSubscriptionAction]]; else → [[appstle#appstleSubscriptionAction]] (which top-guards `healOnTouch` on pause/resume, skips on cancel).

### Schedule

- `subscriptionSkipNextOrder(workspaceId, contractId)` — push the next order out by one billing cycle. Implemented as a change-next-billing-date (Appstle's dedicated skip endpoint is unreliable — see [[appstle-call-log]]).
- `subscriptionUpdateBillingInterval(workspaceId, contractId, interval: "DAY" | "WEEK" | "MONTH" | "YEAR", intervalCount)` — normalizes the enum to UPPERCASE before hitting Appstle; no-op guard when the local sub already carries the target interval/count.
- `subscriptionUpdateNextBillingDate(workspaceId, contractId, nextBillingDate: YYYY-MM-DD | ISO)` — Appstle expects `ZonedDateTime`; date-only input is normalized to `${date}T00:00:00Z`.

### Payment method

- `subscriptionSwitchPaymentMethod(workspaceId, contractId, paymentMethodId)` — internal: flips `customer_payment_methods.is_default` on the passed Braintree token. Appstle: hits `subscription-contracts-update-existing-payment-method` with the `contract_edit_in_progress` guardrail preserved.
- `subscriptionSendPaymentUpdateEmail(workspaceId, contractId)` — Appstle-only; internal returns `internalSubNotYetSupported("send_payment_update_email")`.

### Line items

- `subscriptionAddItem(workspaceId, contractId, variantId, quantity = 1)` — internal: append to `subscriptions.items` (variant-uuid + catalog metadata, no baked price). Appstle: `replace-variants-v3` add + `syncItemsAfterMutation`.
- `subscriptionRemoveItem(workspaceId, contractId, variantOrLine: string | { variantId?, lineGid? })` — internal: filter by variant_id. Appstle: dedicated `subscription-contracts-remove-line-item` endpoint with the "must keep one recurring product" guardrail folded into `would_remove_last_item`. Returns `alreadyAbsent: true` for idempotent removes.
- `subscriptionChangeQuantity(workspaceId, contractId, variantId, quantity)` — internal: rewrite the line's qty in-place. Appstle: `replace-variants-v3` with `carryForwardDiscount: "EXISTING_PLAN"`; title→variantId fallback via `resolveContractVariantId`.
- `subscriptionSwapVariant(workspaceId, contractId, oldVariantId, newVariantId, quantity = 1)` — internal: mutate the item entry (drops any grandfathered override — a swap is a different product). Appstle: `replace-variants-v3` swap; returns `newLineGid` after re-querying the contract (swap creates a new line, old GID is dead).
- `subscriptionUpdateLineItemPrice(workspaceId, contractId, variantId, basePriceCents, lineGid?)` — grandfathered price update. Internal: writes `price_override_cents` (the pricing engine applies qty break + S&S on top). Appstle: resolves the authoritative lineId if not passed, then `subscription-contracts-update-line-item-price`.

### Free product / swap product

- `subscriptionAddFreeProduct(workspaceId, contractId, variantId, quantity = 1)` — `$0` line (gift / promo). Internal: `internalSubAddItem` + rewrite `price_cents` to 0. Appstle: `subscription-contract-add-line-item?price=0&isOneTimeProduct=true`.
- `subscriptionSwapProduct(workspaceId, contractId, oldVariantId, newVariantId)` — Appstle's `subscription-contracts-swap` endpoint (thin wrapper around `subscriptionSwapVariant` semantics for the Appstle path).

### Billing

- `subscriptionAttemptBilling(workspaceId, billingAttemptId)` — immediate billing retry against a specific Appstle attempt id. **Preserves the `internal-*` early return**: a synthetic `internal-<contract>` id (dunning stamps this on internal subs) returns success without hitting Appstle; the real renewal is driven by the internal daily renewal cron (signature `vercel:cdfbac68e30a91f9`).
- `subscriptionOrderNow(workspaceId, contractId)` — flavor-aware "order now" (bill_now). **Preserves the Angel-precedent Braintree-vs-Appstle branch**: internal subs fire the `internal-subscription/renewal-attempt` Inngest event (async Braintree charge → order → Avalara → advance `next_billing_date`); Appstle subs go through `subscription-billing-attempts/top-orders` → `attempt-billing`. See [[appstle#orderNowByContract]] + § Gotchas.

## View types

Re-exports the canonical view shapes for callers building UI on top of the SDK:

- `SubscriptionView` — the sub itself (id + workspace + contract + status + billing schedule + counts).
- `SubscriptionLineView` — one line item (variant + product + qty + resolved money).
- `SubscriptionPricingView` — the fully resolved money envelope (subtotal / discount / shipping / tax / total).

Defined in `src/lib/commerce/types.ts`.

## Callers

Zero consumers as of Phase 1. Once the deprecated shims land in Phase 3 (`appstleX` / `subX` re-exported from here), the existing callers — the portal handlers, the Sonnet orchestrator, the action executor — resolve through the shim. M4/M5 flips them to import from `@/lib/commerce` directly and the shims retire.

## Gotchas

- **Two ops don't branch through `isInternalSubscription()`** because their own semantics are different:
  - `subscriptionAttemptBilling` branches on the billing-attempt id prefix (`internal-*` → early success).
  - `subscriptionOrderNow` branches on the sub's `is_internal` column (fires the Inngest renewal event; no Appstle call).
- **`subscriptionSwitchPaymentMethod`** doesn't branch here either — the internal path lives inside [[appstle#appstleSwitchPaymentMethod]] (the "paymentMethodId" argument IS the `braintree_payment_method_token` for internal subs). Delegating preserves that path exactly.
- **`healOnTouch` is not called at this layer.** The `appstleX` / `subX` wrappers already top-guard with it; adding another call here would double-heal on the Appstle branch. When Phase 3 flips them to shims, the `healOnTouch` call moves up into the ops above.

## Related

- [[../reference/commerce-sdk-inventory]] — rename map + defect register + build plan.
- [[appstle]] — the raw Appstle boundary; will become a `@deprecated` shim over `commerce/subscription` in Phase 3.
- [[subscription-items]] — the Appstle line-item boundary; same Phase 3 flip.
- [[internal-subscription]] — the `is_internal=true` DB-only engine the internal branch delegates to.
- [[appstle-pricing]] — where `healOnTouch` lives.
