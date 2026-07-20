# Confirm Shipping Address

When a customer asks to change their shipping address — for a subscription, for a recent order, or just to update their default — this journey collects the new address, validates it, and applies it where the customer wanted.

DB row in [[../tables/journey_definitions]]: `slug='shipping-address'`, `journey_type='address_change'`, `trigger_intent='shipping_address'`.

## Trigger

- **trigger_intent**: `shipping_address`
- **match_patterns**: empty in DB — fires when the orchestrator detects address-change intent via Sonnet's reasoning, not via simple keyword matching.
- **priority**: 50

The reason for empty patterns: "change my address" is ambiguous (which subscription? which order? for which item?). The orchestrator decides whether this journey is appropriate based on context (does the customer have any active subs? is there a recent unfulfilled order?), then routes.

## Channels

`email`, `chat`, `sms`. (Not `social_comments`, not `meta_dm` — DMs use a different reply pattern for address changes.)

## Steps

Built by `src/lib/shipping-address-journey-builder.ts`:

1. **Select what to update**:
   - Active subscription(s) — if any.
   - A specific recent order — only shown if the order is still unfulfilled.
   - Default address on the customer profile (not actually used for ordering — but customers sometimes care).
2. **Enter new address** — street, apt/unit, city, state, zip, country. Auto-completes via browser autofill (`autocomplete="shipping street-address"` etc.).
3. **Validate** via [[../integrations/easypost]] address verification. EasyPost normalizes + flags non-deliverable addresses.
4. **Confirm** — show the normalized version, ask "is this right?" — yes / edit.

## On submit

For each selected target:

- **Subscription** — [[../libraries/commerce__subscription]] `subscriptionUpdateShippingAddress` updates the contract's shipping address. Internal-aware like every commerce-SDK mutation: an internal sub short-circuits, everything else goes to Appstle's `subscription-contracts-update-shipping-address` endpoint. It is NEVER written through Shopify — see [[../operational-rules]] § Subscription mutations.
- **Order** (unfulfilled only) — [[../integrations/shopify]] `orderUpdateShippingAddress` mutation. If the order is in fulfillment / shipped, we can't change it — flagged earlier in Step 1.
- **Default address** — [[../integrations/shopify]] `customerUpdate` mutation + write to [[../tables/customers]].`default_address`.

Write [[../tables/customer_events]] `address.changed` per target.

## Address validation

EasyPost address verification is the gate. If it can't be delivered (PO box for ground shipping, military / APO addresses with no carrier match), surface the error inline + offer to override (admin discretion).

Some customers use addresses that EasyPost flags as residential vs commercial mismatches — we accept those after a single "are you sure?" confirmation since the carriers themselves will usually deliver anyway.

## Outcomes

| Tag | When |
|---|---|
| `j:shipping_address` | Always |
| `jo:positive` | Address updated successfully on at least one target |
| `jo:negative` | Customer abandoned mid-form |

## Step ticket status

`open`.

## Files

| File | Purpose |
|---|---|
| `src/lib/shipping-address-journey-builder.ts` | Builder |
| `src/lib/commerce/subscription.ts` | `subscriptionUpdateShippingAddress` — internal-aware, Appstle for non-internal |
| `src/lib/shopify-order-actions.ts` | orderUpdateShippingAddress for in-flight orders |
| `src/lib/shopify-customer-update.ts` | customerUpdate for default address |
| `src/lib/easypost.ts` | Address verification |
| `src/lib/address-normalize.ts` | Normalize for downstream storage |
| `src/lib/customer-events.ts` | address.changed event logging |
| `src/app/journey/[token]/page.tsx` | Mini-site form renderer |
| `src/app/api/journey/[token]/complete/route.ts` | Apply changes |

## Related

[[../tables/customers]] · [[../tables/subscriptions]] · [[../tables/orders]] · [[../tables/customer_events]] · [[../integrations/shopify]] · [[../integrations/easypost]] · [[../tables/journey_definitions]]
