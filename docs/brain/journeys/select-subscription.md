# Select Subscription

Helper journey. When a customer has multiple subscriptions and the orchestrator (or a playbook) needs to know which one the customer is asking about, this journey presents a picker.

DB row in [[../tables/journey_definitions]]: `slug='select-subscription'`, `journey_type='custom'`, `trigger_intent='select_subscription'`.

## Trigger

- **trigger_intent**: `select_subscription`
- **match_patterns**: empty — never matches customer messages directly.
- **priority**: 50

Triggered by:

- [[../playbooks/refund]] when it needs to disambiguate which sub the customer is disputing.
- [[../lifecycles/cancel-flow]] when the customer has multiple subs and didn't specify one in their cancel request.
- Any other playbook / journey that needs a subscription pinned.

## Channels

`email`, `chat`, `sms`. (Not `social_comments`, not `meta_dm`.)

## Steps

Built by `src/lib/select-subscription-journey-builder.ts`:

1. **Subscription picker** — collapsible cards from `getCustomerSubscriptions()` (across [[../tables/customer_links]] linked accounts).
   - Each card shows: product list, frequency, next billing date, total monthly price.
   - Shipping protection shown as a green badge, NOT a line item.
   - First-renewal subs show "Your first shipment" instead of a renewal date (avoids payment anxiety).
   - Status badges: Active / Paused / In Recovery / Payment Failed.

If the customer has 0 active subs, the journey short-circuits with a "you don't have any active subscriptions" message + closes.

If they have exactly 1 sub, the journey may auto-select and bypass the picker (depends on the calling context).

## On submit

Returns the selected `subscription_id` to the calling context (parent playbook continues, or the cancel journey advances to step 2). The picker itself doesn't mutate any subscription state.

## Files

| File | Purpose |
|---|---|
| `src/lib/select-subscription-journey-builder.ts` | Builder |
| `src/lib/cancel-journey-builder.ts` | Uses this internally when needed |
| `src/lib/playbook-executor.ts` | Calls this from playbook steps |
| `src/lib/customer-stats.ts` | getCustomerSubscriptions helper |
| `src/app/journey/[token]/page.tsx` | Renderer |
| `src/app/api/journey/[token]/complete/route.ts` | Hand off to parent |

## Related

[[cancel]] · [[../playbooks/refund]] · [[../tables/subscriptions]] · [[../tables/customer_links]] · [[../tables/journey_definitions]]
