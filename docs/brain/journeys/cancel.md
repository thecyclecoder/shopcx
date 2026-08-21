# Cancel Subscription

AI-powered retention flow. Database row in [[../tables/journey_definitions]]: `slug='cancel-subscription'`, `journey_type='cancellation'`, `trigger_intent='cancel_subscription'`. Replaces the legacy "Cancellation Flow" config-driven journey.

See [[../lifecycles/cancel-flow]] for the end-to-end trace.

## Trigger

- **trigger_intent**: `cancel_subscription`
- **match_patterns** (from DB): "cancel my subscription", "cancel subscription", "stop charging me", "cancel my order", "stop my subscription", "cancel my account", "cancel account", "want to cancel", "i want to cancel", "cancle", "cancell", "canel", "unsubscribe", "stop subscription", "end my subscription", "end subscription", "close my account", "stop my order", "stop sending", "stop deliveries", "cancel deliveries", "dont want it anymore"
- **priority**: 5 (high — fires before most other journeys)

Typos are intentional — common misspellings shouldn't fail-open to AI-improvised cancels.

## Channels

`email`, `chat`, `sms`, `meta_dm`. (Not `social_comments` — never.)

## Steps

Built live by `src/lib/cancel-journey-builder.ts`. Sequence:

1. **Subscription selection** — skipped if only one active sub. Collapsible cards with product list, frequency, next billing date, total price. Shipping protection shown as green badge, not a line item. First-renewal subs show "Your first shipment" instead of a renewal date.

2. **Cancel reason** — loaded from [[../tables/workspaces]].`portal_config.cancel_flow.reasons`. Each reason has `slug`, `label`, `type` (`remedy` or `ai_conversation`), `enabled`, `sort_order`, `suggested_remedy_id`. No hardcoded defaults — empty config renders an empty step.

3. **Remedies OR AI chat**:
   - `type='remedy'` — Haiku picks top 3 from [[../tables/remedies]] via `src/lib/remedy-selector.ts`. Considers customer LTV, retention score, subscription age, first-renewal status, and historical acceptance rates from [[../tables/remedy_outcomes]] (per-reason if 200+ data points, else global). Social-proof review from [[../tables/product_reviews]] (AI-summarized ≤ 15 words) shown below.
   - `type='ai_conversation'` — open-ended Sonnet chat, max 3 turns. Used for "just need a break" / "reached goals" / "something else."

4. **Confirm cancel** — "Are you sure?" — not guilt-trippy, just a clean confirmation.

## Remedy execution

On accept, action dispatch by remedy type:

| type | What |
|---|---|
| `coupon` | `applyDiscountWithReplace()` ([[../integrations/appstle]] — replaces any existing first) |
| `pause` | `appstleSubscriptionAction("pause")` + schedule auto-resume via [[../inngest/portal-auto-resume]] |
| `skip` | `appstleSkipNextOrder()` (disabled — Appstle endpoint unreliable; see project_appstle_disabled_features) |
| `frequency_change` | `appstleUpdateBillingInterval()` |
| `free_product` | `appstleAddFreeProduct()` |
| `line_item_modifier` | Multi-step frontend flow (add/remove/swap items) |

Every offered + accepted/declined remedy writes to [[../tables/remedy_outcomes]] for AI learning. `first_renewal` boolean tracked separately so first-renewal save rate stays distinct from steady-state.

## Cancel execution

If all remedies declined:

- [[../integrations/appstle]] DELETE `subscription-contracts/{id}?cancellationFeedback={slug}&cancellationNote=Cancelled by {display_name} on ShopCX.ai — {reason}`
- Write [[../tables/customer_events]] `subscription.cancelled`
- Update [[../tables/customers]].`subscription_status` if this was the last sub

## Outcomes

| Tag | When |
|---|---|
| `j:cancel` | Always |
| `jo:positive` | Customer saved (accepted a retention offer) |
| `jo:negative` | Customer cancelled |

No neutral outcome — binary.

## Step ticket status

`open` — ticket stays open between steps so the agent can intervene if needed.

## Route past remedies on re-request

Ticket `6c12a925-8851-4a07-b7be-6ba6234d842f` (Afi, 2026-08) surfaced the trap: a customer completes the cancel journey into a `saved_remedy` (accepted a pause / coupon / skip), hears **"We've updated your subscription. Thank you for staying with us!"**, then immediately re-asks in words *"Cancel my subscription"*. The next cancel-journey delivery would re-present the same remedy step; [[../action-executor]] `directActionHandlers` exposes no cancel action; [[../libraries/no-progress-guard]] escalates to human review with no in-leash tool; the subscription stays active and the customer is trapped.

Structural fix:

- **[[../libraries/journey-delivery]] `launchJourneyForTicket`** — for a cancel-intent launch, invokes [[../libraries/cancel-journey-guard]] `hasRecentSavedRemedy(admin, workspaceId, ticketId)` before creating the `journey_sessions` row. On a prior `saved_%` outcome for this ticket, stamps `config_snapshot.directToCancelTerminal = true` and drops an internal `[System]` note. Callers can also pass the flag explicitly.
- **`src/app/journey/[token]/page.tsx` `CancelJourneyClient`** — reads `directToCancelTerminal` off the config. When set and the subscription is resolved (single-sub, pre-selected, or none), the phase state machine jumps straight to `confirm_cancel`, skipping subscription→reason→remedies.
- **[[../libraries/no-progress-guard]] `applyNoProgressCircuit`** — when the 3-inbound streak trips AND [[../libraries/cancel-journey-guard]] `looksLikeCancelIntent` matches any of those inbounds, calls `attemptCancelJourneyResend` INSTEAD of escalating (in-leash progress). Returns `{tripped: true, streak, resent: true}`; the handler stamps `status='no_progress_cancel_resent'`.

**Cancellation still completes only via the customer's own confirm button on the mini-site.** The `directToCancelTerminal` flag skips OFFERS, not the action. The self-service-only rule ([[../operational-rules]] § North star; [[../libraries/sol-direction-apply]] `isSelfServiceOnlyIntent`) still holds — no `directActionHandlers` cancel action is added and no `.update({status: 'cancelled'})` is written on the customer's behalf.

## Grandfathered pricing

Customers with sub prices below `workspaces.coupon_price_floor_pct` of MSRP are filtered out of coupon remedies (they already have a good deal). Loyalty coupons are always allowed (separate tier system).

## First-renewal aggressiveness

Customers where `subscription_age_days < billing_interval_days` get aggressive save offers (25-40% discounts, "extend your trial" framing). Haiku prompt includes the `first_renewal=true` flag.

## Files

| File | Purpose |
|---|---|
| `src/lib/cancel-journey-builder.ts` | THE builder — steps + metadata |
| `src/lib/cancel-journey-guard.ts` | `looksLikeCancelIntent` + `hasRecentSavedRemedy` — route-past-remedies detection ([[../libraries/cancel-journey-guard]]) |
| `src/lib/remedy-selector.ts` | Haiku remedy selection + Sonnet open-ended chat |
| `src/lib/journey-launcher.ts` | Launcher |
| `src/lib/journey-delivery.ts` | Channel delivery |
| `src/lib/journey-seed.ts` | Default remedies seed |
| `src/lib/appstle.ts` | All Appstle calls |
| `src/lib/appstle-discount.ts` | applyDiscountWithReplace |
| `src/lib/subscription-items.ts` | line_item_modifier flow |
| `src/lib/klaviyo.ts` | Reviews fetch for social proof |
| `src/lib/portal/handlers/cancel-journey.ts` | Customer portal path |
| `src/lib/inngest/portal-auto-resume.ts` | Pause auto-resume cron |
| `src/app/journey/[token]/page.tsx` | Mini-site renderer |
| `src/app/api/journey/[token]/remedies/route.ts` | Haiku remedy endpoint |
| `src/app/api/journey/[token]/chat/route.ts` | Sonnet open-ended endpoint |
| `src/app/api/journey/[token]/complete/route.ts` | Final execution |

## Related

[[../lifecycles/cancel-flow]] · [[../tables/journey_definitions]] · [[../tables/journey_sessions]] · [[../tables/remedies]] · [[../tables/remedy_outcomes]] · [[../tables/coupon_mappings]] · [[../tables/product_reviews]] · [[../integrations/appstle]] · [[../integrations/anthropic]] · [[../integrations/klaviyo]] · [[discount-signup]] · [[crisis-tier3-pause-remove]]
