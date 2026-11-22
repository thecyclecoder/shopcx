# Next Order (in-journey subscription editor)

The next-order journey gives subscribers the portal's full subscription editor **inside** the journey mini-site — swap, change quantity, add, remove, skip, change date, change frequency — plus an in-journey cancel that runs through the same cancel saves. A pre-renewal reminder (M2) links here so the customer acts instead of bouncing to the portal. Database row in [[../tables/journey_definitions]]: `slug='next-order'`, `journey_type='custom'`, `trigger_intent='next_order'`, `channels={email,sms}`.

Part of the [[../goals/pre-renewal-reminder-next-order-journey]] M1 milestone. This is the surface the 50/50 test's treatment arm points at.

## Trigger

- **trigger_intent**: `next_order` (also matches `next-order`)
- **channels**: `email`, `sms`

## Steps

Built live by `src/lib/next-order-journey-builder.ts` (`buildNextOrderJourneySteps`), delegated to from the switch in [[../libraries/journey-step-builder]]. Like every journey it is **live-rendered** on each click — the builder reads the customer's current active + paused subscriptions and the workspace product catalog; nothing is cached back to `config_snapshot`.

1. **Subscription selection** — skipped when the customer has exactly one active/paused sub, or when the launcher pre-selected one (`journey_sessions.subscription_id` → `metadata.selectedSubscriptionId`). Mirrors the [[select-subscription]] / [[cancel]] picker pattern.
2. **Editor** — one interactive step rendered by the mini-site (`src/app/journey/[token]/page.tsx` → `NextOrderJourney`). Exposes swap / change quantity / add / remove / skip / change date / change frequency, plus a "Cancel subscription" entry point.

## Edits dispatch through the shared executors (no forked edit path)

Every mutation POSTs to `src/app/api/journey/[token]/edit/route.ts`, which dispatches through the **same** shared executors the portal uses — there is exactly one implementation of each edit:

| Journey action | Executor |
|---|---|
| swap / swap_product | `executeLineItemAction` ([[../libraries/remedy-actions]]) → `subSwapVariant` ([[../libraries/subscription-items]]) |
| change quantity | `executeLineItemAction` → `subChangeQuantity` |
| remove | `executeLineItemAction` → `subRemoveItem` |
| add item | `subAddItem` ([[../libraries/subscription-items]]) |
| skip | `subscriptionSkipNextOrder` (`src/lib/commerce/subscription.ts`) |
| change date | `subscriptionUpdateNextBillingDate` |
| change frequency | `subscriptionUpdateBillingInterval` |

These route across all three billing engines (internal / shopcx / appstle) and carry the portal's mutation guards (first-delivery lock, failed-payment block, last-item-removal guard). This closes the [[cancel]] `line_item_modifier` gap where the journey had no editor of its own and handed the customer a magic link into the portal `/subscriptions` editor.

## In-journey cancel (same cancel flow + save offers)

The editor's "Cancel subscription" entry point runs the existing cancel journey's sequence without leaving the surface: reason (from [[../tables/workspaces]] `portal_config.cancel_flow.reasons`) → AI-selected save offers via `POST /remedies` ([[../libraries/remedy-selector]] `selectRemedies`) → confirm. Accepting a save applies it through `executeRemedyAction` ([[../libraries/remedy-actions]]) in `POST /complete`; declining all cancels. Cancellation completes **only** via the customer's own confirm action — never an agent-written status update (self-service-only rule).

## Verify-before-report + lifecycle events

- **Verify-before-report**: the `/edit` route reads back the executor result before composing the customer message. A failed/unresolvable edit never reports success — it leaves the ticket open (`status='open'`, `handled_by=null`), raises a high-severity [[../tables/dashboard_notifications]] row, and tells the customer the team will apply it. Same pattern the [[cancel]] save surface already uses.
- **Lifecycle events**: `opened` (GET loader), `edited` / `skipped` (`/edit`), `cancelled` / `saved` (`/complete`) are written to [[../tables/journey_step_events]] keyed by the `journey_sessions` row (`step_key='lifecycle'`, `response_value=<event>`) so the M3 harness + M4 dashboard can join engagement to the experiment arm.

## Files

- `src/lib/next-order-journey-builder.ts` — steps + metadata (single source of truth)
- `src/lib/journey-step-builder.ts` — `next_order` switch case
- `src/app/api/journey/[token]/edit/route.ts` — edit dispatch through shared executors
- `src/app/api/journey/[token]/route.ts` — GET loader flags `nextOrderJourney`, pre-selects sub, emits `opened`
- `src/app/api/journey/[token]/remedies` + `/complete` — reused for in-journey cancel + saves
- `src/app/journey/[token]/page.tsx` — `NextOrderJourney` editor renderer
- Migration: `supabase/migrations/20261119123000_next_order_journey.sql`
