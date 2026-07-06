# commerce SDK

Umbrella index for the `src/lib/commerce/*` op set — the internal-aware wrappers every Display + Mutation callsite is being migrated onto. Every op lives in a per-surface file (order.ts, subscription.ts, refund.ts, replacement.ts, return.ts, loyalty.ts, chargeback.ts, fraud.ts, crisis.ts, customer.ts, price.ts). The individual files each have their own brain page ([[commerce__order]], [[commerce__subscription]], [[commerce__refund]], [[commerce__replacement]], …); this one is the cross-surface index.

The per-callsite migration ledger — every entry point still calling a raw vendor primitive vs. the SDK op — lives in [[../reference/commerce-sdk-inventory]].

## Design invariants

- **Every op is internal-vs-vendor aware.** Mutation ops branch on the vendor / `is_internal` flag before firing an upstream API call. Callers pass a stable input shape; the SDK owns the vendor round trip. See [[commerce__subscription]] § MUTATION.
- **Ships with parity harness, not a big-bang swap.** Every op is added with zero call-site consumers first — the M3 harness compares Display output vs. the raw path before any surface migrates. Post-Phase-3, all raw entry points route through the SDK.
- **No silent 1000-row cap.** List ops cursor-paginate past PostgREST's default cap ([[../README#probing-technique]]).
- **`orders.line_items` is frozen at create time.** Display reads the row as-is — no live re-price.

## Mutation ops — create primitives (Phase 1 of [[../specs/commerce-sdk-actions-create-order-create-subscription-refund-and-dollar-replacement]])

Compiler-loop primitives that create fresh orders + subscriptions from scratch. Wired into `directActionHandlers` in [[action-executor]] as `create_order` + `create_subscription`.

### `createOrder(workspaceId, input)`

`src/lib/commerce/order.ts` — internal-aware dispatcher for creating a fresh order.

- `input.vendor === 'shopify'` → creates a real Shopify order via `shopify-draft-orders.createShopifyOrder` (draft-order + complete, no discount), stamps `shopify_order_id` + `order_number` on the mirror `orders` row.
- `input.vendor === 'internal'` → inserts the mirror `orders` row directly. `shopify_order_id` stays null.

Input shape (`CreateOrderInput`): `{ vendor, customer_id, email, line_items[], currency?, shipping_address?, billing_address?, subscription_id?, order_type?, tags?, source_name? }`. `line_items[i]` = `{ variant_id, product_id?, title, quantity, unit_cents }`.

Returns `{ success, order_id, shopify_order_id?, order_number?, error? }`.

Pure helper: `buildCreateOrderRow(workspaceId, input, opts?)` — returns the `orders`-row shape without touching Supabase. Pinned in [[../../src/lib/commerce/order.create.test]].

### `createSubscription(workspaceId, input)`

`src/lib/commerce/subscription.ts` — internal-aware dispatcher for creating a fresh subscription.

- `input.vendor === 'internal'` → inserts a `subscriptions` row with `is_internal=true`, `status='active'` (default), and `next_billing_date` populated. No upstream round trip. When `shopify_contract_id` is omitted, the SDK stamps a synthetic `internal-<uuid>` post-insert so the row satisfies the not-null contract-id constraint.
- `input.vendor === 'appstle'` → Phase 1 does not ship this; returns `{ success: false, error: "…not supported in Phase 1…" }`. A future phase will fold the Appstle contract-create call into this branch.

Input shape (`CreateSubscriptionInput`): `{ vendor, customer_id, items[], billing_interval, billing_interval_count, next_billing_date, status?, is_internal?, comp?, shipping_address?, delivery_price_cents?, applied_discounts?, payment_method_id?, shopify_contract_id? }`. `items[i]` = `{ variant_id, product_id?, title?, variant_title?, sku?, quantity?, is_gift?, price_override_cents? }`.

Returns `{ success, subscription_id, shopify_contract_id, error? }`.

Pure helper: `buildCreateSubscriptionRow(workspaceId, input, opts?)` — returns the `subscriptions`-row shape without touching Supabase. Pinned in [[../../src/lib/commerce/subscription.create.test]].

## Mutation ops — refund (Phase 2 of [[../specs/commerce-sdk-actions-create-order-create-subscription-refund-and-dollar-replacement]])

### `issueRefund(workspaceId, args)`

`src/lib/commerce/refund.ts` — SDK-side facade for order refunds. Delegates to the underlying gateway-aware dispatcher in [[../../src/lib/refund]] (`refundOrder`), which stays as the shared implementation for Inngest steps + non-commerce callsites (see the Defect register in [[../reference/commerce-sdk-inventory]]).

Args shape (`IssueRefundArgs`): `{ orderId, amountCents, reason, source?, customerId?, eventProperties?, dryRun? }`. `orderId` is the internal `orders.id` UUID — callers resolve human-facing `shopify_order_id` / `order_number` to a UUID before calling.

Returns `{ success, method?: 'shopify' | 'braintree', refund_id?, error?, needsManualShopifyRecord?, dryRun? }`.

Guarantees preserved from `refundOrder`:

- **Gateway routing** — orders with no `shopify_order_id` (SHOPCX*/internal) refund via Braintree; Shopify orders route through `partialRefundByAmount` with its own Shopify↔Braintree fallback.
- **Double-refund guard** — on success, stamps `refunded_at` on every open (`refunded_at IS NULL`) return for this order in this workspace so the returns Inngest step can't refund the customer a second time. Compare-and-set on `workspace_id` + `refunded_at IS NULL` — can't overwrite an already-stamped row or reach across tenants.
- **customer_events log** — writes one `order.refunded` row with method + amount + reason + caller-supplied `eventProperties` (ticket_id, subscription_id, loyalty_tier, points_spent, …).

Callsites migrated to `commerce/refund.issueRefund` in Phase 2:

- `directActionHandlers.partial_refund` in [[action-executor]] — AI `partial_refund` direct action.
- `directActionHandlers.redeem_points_as_refund` in [[action-executor]] — AI loyalty-points redemption.

Callsites that still call `@/lib/refund.refundOrder` directly (unchanged): the `returns-issue-refund` Inngest step, the ticket-detail Improve tab refund route, the manual return-refund route, the fraud-case `cancel_refund_orders` step (see [[../reference/commerce-sdk-inventory]] § Defect register). Those migrate as their surrounding surfaces move onto commerce/*.

## Mutation ops — replacement (Phase 3 of [[../specs/commerce-sdk-actions-create-order-create-subscription-refund-and-dollar-replacement]])

### `issueReplacement(workspaceId, args)`

`src/lib/commerce/replacement.ts` — SDK-side wrapper over [[../../src/lib/replacement-order]] `createReplacementOrder`. Kept as a thin surface so future concerns (per-workspace policy checks, mirror writes) drop in at the SDK boundary without touching every callsite.

### `issueDollarReplacement(workspaceId, args)`

`src/lib/commerce/replacement.ts` — the $-bearing replacement variant. Ships a replacement AND moves money atomically. Two flavors:

- **Refund flavor** (`args.refund = { orderId, amountCents, reason }`) — replacement + refund back on the original order via `commerce/refund.issueRefund`. On success, best-effort mirror write to `order_refunds` (the mirror table ships with the M1 spec — until it does, the insert soft-fails with a warning; the refund already moved money, so a mirror miss is never a rollback trigger).
- **Upcharge flavor** (`args.upcharge = { contractId }`) — replacement + fresh bill_now via `commerce/subscription.subscriptionOrderNow`.

Atomicity (compensating rollback): the replacement is created FIRST (record-first — `replacements` row + Shopify draft-complete). If the money half fails, `rollbackReplacement` deletes the just-created row so no orphan record survives. The delete is guarded on `workspace_id` (never cross-tenant) + `id` (exactly one row) + `status NOT IN ('shipped','delivered')` (never destroy a fulfilled row on a race) + `.select('id')` (assert exactly one row transitioned; zero → treat as no-op).

Testability: `issueDollarReplacement` accepts an optional `_deps` param (Partial<DollarReplacementDeps>) so the atomicity harness in [[../../src/lib/commerce/replacement.dollar.test]] can drive it deterministically without standing up Supabase + Shopify + Braintree. Real callers omit the param and get production wiring.

Wired to `directActionHandlers.dollar_replacement` in [[action-executor]] — action shape `{ variant_id, quantity, replacement_amount_cents, shopify_order_id | order_number, reason, address? }`. See [[../playbooks/replacement-order#-bearing-replacement-variant-dollar_replacement]] for the operator-facing description.

## Related

- [[../reference/commerce-sdk-inventory]] — per-callsite migration ledger
- [[commerce__order]] · [[commerce__subscription]] · [[commerce__refund]] · [[commerce__replacement]] · [[commerce__return]] · [[commerce__customer]] · [[commerce__loyalty]] · [[commerce__chargeback]] · [[commerce__fraud]] · [[commerce__crisis]] · [[commerce__price]]
- [[action-executor]] — `directActionHandlers.create_order` + `.create_subscription` are the compiler-loop entry points
- [[../specs/commerce-sdk-actions-create-order-create-subscription-refund-and-dollar-replacement]] — driving spec
