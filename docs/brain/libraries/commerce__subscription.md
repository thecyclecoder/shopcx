# libraries/commerce__subscription

The subscription surface of the [[commerce-sdk-inventory|Centralized Commerce SDK]] — one file carrying **both** the read/list **Display** ops and the canonical **Mutation** ops. Every op is internal-vs-Appstle-aware: Display prices via [[commerce__price]] `priceSubscription`; Mutation branches on `isInternalSubscription()` from [[internal-subscription]].

**File:** `src/lib/commerce/subscription.ts` · **Spec:** [[../specs/commerce-sdk-display-operations]] Phase 1 (Display) + [[../specs/commerce-sdk-mutations-rename-subscription-prefix]] (Mutation) · **Depends on:** [[commerce__price]] · [[internal-subscription]] · [[appstle]] · [[subscription-items]] · [[../tables/subscriptions]] · [[../tables/orders]]

## Why this exists

The M2 goal ([[../specs/spec-goal-branch-pm-flow]] · Centralized Commerce SDK) collapses every surface's per-page subscription hydration AND every subscription mutation onto one contract.

Display invariants:

- **No money render says `$NaN` / `$0` / `undefined`.** Every read runs the sub through [[commerce__price]] `priceSubscription`, so `SubscriptionView.pricing` is populated on internal (engine-priced) AND Appstle-baked branches with a `PriceInvariantError` on any drift.
- **No silent truncation.** Ad-hoc `.from('subscriptions').select(...)` is capped at 1000 rows by PostgREST. The list ops cursor-paginate on `(updated_at DESC, id DESC)` via the `commerce_list_subscriptions` RPC (see [[../tables/subscriptions]] and `supabase/migrations/20260914120000_commerce_list_subscriptions_rpc.sql`), so a workspace with >1000 subs is walked to completion.

Mutation: every subscription mutation flows through here as one canonical `subscriptionX` op set (renaming the current `appstleX` + `subX` exports). Internal → the `internalSub*` handlers; else → the existing [[appstle]] / [[subscription-items]] wrappers, which top-guard with `healOnTouch` from [[appstle-pricing]] and handle the Appstle boundary.

Ships with zero call-site consumers. The M3 harness compares SDK output to the current portal / dashboard / AI hydration paths before any surface migrates; M2/Phase 3 flips the `appstleX` / `subX` exports to thin `@deprecated` shims that call the ops below; M4/M5 migrates callers off the shims. Full pairing: see [[../reference/commerce-sdk-inventory#rename-map|commerce-sdk-inventory § Rename map]].

## Display exports

- **`getSubscription(workspaceId, subId)`** → `SubscriptionView` — one sub fetched by internal UUID, priced for display, latest renewal joined in a follow-up round trip. Throws when the sub is missing or not in the given workspace.
- **`listSubscriptionsByCustomer(workspaceId, customerId)`** → `SubscriptionView[]` — every sub for one customer (direct `customer_id` match — link-follow is a caller concern), priced and paginated the same way as `listSubscriptions`.
- **`listSubscriptions(workspaceId, filters?)`** → `SubscriptionView[]` — a workspace's subs with optional `SubscriptionListFilters` (`status`, `last_payment_status`, `is_internal`, `comp`, `customer_id`, `page_size`, `max_rows`). Backs onto the `commerce_list_subscriptions` RPC — each page projects sub + latest_order + upcoming_order in one round trip; the SDK walks the cursor until fewer rows than `page_size` come back or `max_rows` caps it. Default `page_size = 500`, default `max_rows = ∞`.

The RPC's returned upcoming_order carries just `next_billing_date`; the SDK fills in `projected_total_cents` from `priceSubscription`'s rollup on the same view.

### SubscriptionView latest_order + upcoming_order

Compact projections joined by the list RPC so a caller can render a subscription card without a second query:

- `latest_order` — `{ id, order_number, financial_status, delivery_status, total_cents, created_at, delivered_at }` from the most recent [[../tables/orders]] row keyed on `subscription_id`. `null` when the sub has never billed. Full `OrderView` arrives via [[commerce__order]].
- `upcoming_order` — `{ next_billing_date, projected_total_cents }` where `projected_total_cents` comes from `priceSubscription`'s own rollup on the same view. `null` when the sub carries no `next_billing_date`.

## Mutation exports

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

Type re-exports for callers building UI on top of the SDK: `SubscriptionView`, `SubscriptionLineView`, `SubscriptionPricingView`, `SubscriptionListFilters`. Defined in `src/lib/commerce/types.ts`.

## Callers

None. The M3 harness ([[../specs/spec-goal-branch-pm-flow]] M3) compares SDK output vs the existing per-surface hydration paths before rollout — no consumer is retargeted yet. Once the deprecated shims land in Phase 3 (`appstleX` / `subX` re-exported from here), the existing callers — the portal handlers, the Sonnet orchestrator, the action executor — resolve through the shim. M4/M5 flips them to import from `@/lib/commerce` directly and the shims retire.

## Gotchas

- **Two mutation ops don't branch through `isInternalSubscription()`** because their own semantics are different:
  - `subscriptionAttemptBilling` branches on the billing-attempt id prefix (`internal-*` → early success).
  - `subscriptionOrderNow` branches on the sub's `is_internal` column (fires the Inngest renewal event; no Appstle call).
- **`subscriptionSwitchPaymentMethod`** doesn't branch here either — the internal path lives inside [[appstle#appstleSwitchPaymentMethod]] (the "paymentMethodId" argument IS the `braintree_payment_method_token` for internal subs). Delegating preserves that path exactly.
- **`healOnTouch` is not called at this layer.** The `appstleX` / `subX` wrappers already top-guard with it; adding another call here would double-heal on the Appstle branch. When Phase 3 flips them to shims, the `healOnTouch` call moves up into the ops above.

## Verification

The Phase 1 Display verification probe is `scripts/_probe-commerce-display-subs.ts`. Two checks:

- **Walk past 1000.** Picks the largest workspace by `subscriptions.workspace_id` bucket (or a `--workspace=<uuid>` override), runs `listSubscriptions`, asserts the returned count exceeds 1000 when the DB count does.
- **Appstle canary pricing to the cent.** Optional (opt-in via `--canary-sub=<uuid>`). Reads the sub row + runs `getSubscription`, asserts `SubscriptionView.pricing.total_cents` matches `priceSubscription`'s own rollup to the cent — locks in the invariant that the SDK's view doesn't drift from the money resolver.

Install the RPC first: `npx tsx scripts/apply-commerce-list-subscriptions-rpc-migration.ts`.

## Related

- [[../reference/commerce-sdk-inventory]] — rename map + defect register + build plan.
- [[appstle]] — the raw Appstle boundary; will become a `@deprecated` shim over `commerce/subscription` in Phase 3.
- [[subscription-items]] — the Appstle line-item boundary; same Phase 3 flip.
- [[internal-subscription]] — the `is_internal=true` DB-only engine the internal branch delegates to.
- [[appstle-pricing]] — where `healOnTouch` lives.

---

[[../README]] · [[../../CLAUDE]] · [[commerce__price]]
