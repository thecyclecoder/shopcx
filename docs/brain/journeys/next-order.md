# Next Order (in-journey subscription editor)

The next-order journey gives subscribers the portal's full subscription editor **inside** the journey mini-site — swap, change quantity, add, remove, skip, change date, change frequency — plus an in-journey cancel that runs through the same cancel saves. A pre-renewal reminder (M2) links here so the customer acts instead of bouncing to the portal. Database row in [[../tables/journey_definitions]]: `slug='next-order'`, `journey_type='custom'`, `trigger_intent='next_order'`, `channels={email,sms}`.

Part of the [[../lifecycles/pre-renewal-reminder-journey]] flow (M1 milestone). This is the surface the 50/50 test's treatment arm points at.

## Trigger

- **trigger_intent**: `next_order` (also matches `next-order`)
- **channels**: `email`, `sms`

## Steps

Built live by `src/lib/next-order-journey-builder.ts` (`buildNextOrderJourneySteps`), delegated to from the switch in [[../libraries/journey-step-builder]]. Like every journey it is **live-rendered** on each click — the builder reads the customer's current active + paused subscriptions and the **shared** swap/add catalog ([[../libraries/portal__editable-catalog]] `loadEditableCatalog`); nothing is cached back to `config_snapshot`.

### Catalog + prices are the Portal's, through shared helpers (CEO parity rule, 2026-11-22)

- **Catalog** — the builder no longer loads every `products` row. It calls `loadEditableCatalog(workspaceId)` ([[../libraries/portal__editable-catalog]]), the SAME helper the Portal bootstrap uses: limited to `portal_config.general.products_available_to_add`, Shipping Protection excluded by configured id, suppressed + out-of-stock + non-consumable variants dropped. The CEO rule "only swap/add INTO an in-stock consumable" lives in `isSwappableConsumable` and is enforced server-side on both surfaces via `assertSwappableConsumable`. In-stock is proven by canonical storefront on-hand (`src/lib/inventory/read.ts` `getShopifyOnHandByVariant`) — NOT the retired `inventory_quantity` scalar (always NULL), which is how out-of-stock variants used to leak.
- **Prices** — subscription line prices + total come through the ONE money resolver `priceSubscription` ([[../libraries/commerce__price]]) for every engine — the same resolver the Portal / mini-site / reminder use, so all surfaces show the same number. Swap/add previews use the journey price-quote route `src/app/api/journey/[token]/price-quote/route.ts`, which mirrors the Portal's `price-quote.ts` and is scoped to the session's (linked) subscriptions.

1. **Subscription selection** — skipped when the customer has exactly one active/paused sub, or when the launcher pre-selected one (`journey_sessions.subscription_id` → `metadata.selectedSubscriptionId`). Mirrors the [[select-subscription]] / [[cancel]] picker pattern.
2. **Editor** — one interactive step rendered by the mini-site (`src/app/journey/[token]/page.tsx` → `NextOrderJourney`). Exposes swap / change quantity / add / remove / skip / change date / change frequency, plus a "Cancel subscription" entry point.

## Edits dispatch through the shared executors (no forked edit path)

Every mutation POSTs to `src/app/api/journey/[token]/edit/route.ts`, which dispatches through the **same** shared executors the portal uses — there is exactly one implementation of each edit:

| Journey action | Executor |
|---|---|
| swap / swap_product | `executeLineItemAction` ([[../libraries/remedy-actions]]) → `subSwapVariant` ([[../libraries/subscription-items]]) |
| change quantity | `executeLineItemAction` → `subChangeQuantity` |
| remove | `executeLineItemAction` → `subRemoveItem`. Removing the only **product line** is refused up front with a `last_item` validation message (swap, skip or cancel instead) — gated on `isLastProductLine(sub, variantId)` (exported from `src/lib/next-order-journey-builder.ts`), the SAME predicate the Portal's remove guard uses so Shipping Protection lines never count (a sub carrying one product + protection is still single-product). The builder stamps `removable=false` on that last line via the same predicate, and the mini-site hides Remove + shows "Only item — skip or cancel below" in its place, so an empty-the-sub remove never reaches `raiseFailedEdit`. (2026-11-24 first-run bug: 6 customers tapped Remove on their only item and the team got high-severity "apply manually" cards.) |
| add item | `subAddItem` ([[../libraries/subscription-items]]) |
| skip | `subscriptionSkipNextOrder` (`src/lib/commerce/subscription.ts`) |
| change date | `subscriptionUpdateNextBillingDate`. The requested date must be strictly in the **future** — a past/today date is rejected before dispatch as a `date_in_past` validation message ("Please choose a date in the future"), and the mini-site's date input carries `min=tomorrow`. The ShopCX engine (`shopifySetNextBillingDate`) refuses a non-future date with a Shopify userError; on the first live run (2026-11-24) that fell through to `raiseFailedEdit` as a manual ticket with NO stored reason, so the guard maps it to a customer-fixable message instead. |
| change frequency | `changeSubscriptionFrequency` ([[../libraries/subscription-frequency]]) — shared full sequence: engine write → roll `next_billing_date` forward by the new cadence → display sync. The Portal frequency handler calls the SAME helper. (Previously the journey called `subscriptionUpdateBillingInterval` alone and skipped the roll-forward, re-pinning the cycle and stranding the sub — Ashley Denson, 2026-10-08.) |

These route across all three billing engines (internal / shopcx / appstle). ⚠ **The earlier claim that the shared executors "carry the portal's mutation guards" was wrong** — the Portal's guards lived in its handlers, not the executors. The journey edit route now applies the Portal-parity guards **itself, before dispatch** (`runPortalParityGuards`): the first-delivery lock (`canMutateSubscription`, [[../libraries/portal__mutation-guard]]), the failed-payment block on date/frequency (`shouldBlockForFailedPayment`, `src/lib/portal/failed-payment-guard.ts`), and the selectability + consumable/in-stock guards on new swap/add targets (`assertNewVariantsSelectable` + `assertSwappableConsumable`). A blocked guard returns a customer-safe validation message — not a "team will handle it" failure. This closes the [[cancel]] `line_item_modifier` gap where the journey had no editor of its own and handed the customer a magic link into the portal `/subscriptions` editor.

## In-journey cancel (same cancel flow + save offers)

The editor's "Cancel subscription" entry point runs the existing cancel journey's sequence without leaving the surface: reason (from [[../tables/workspaces]] `portal_config.cancel_flow.reasons`) → AI-selected save offers via `POST /remedies` ([[../libraries/remedy-selector]] `selectRemedies`) → confirm. Accepting a save applies it through `executeRemedyAction` ([[../libraries/remedy-actions]]) in `POST /complete`; declining all cancels. Cancellation completes **only** via the customer's own confirm action — never an agent-written status update (self-service-only rule).

## Verify-before-report + lifecycle events

- **Verify-before-report**: the `/edit` route reads back the executor result before composing the customer message. A failed/unresolvable edit never reports success — it leaves the ticket open (`status='open'`, `handled_by=null`), raises a high-severity [[../tables/dashboard_notifications]] row (with customer + subscription id **and the executor error string** in metadata — `raiseFailedEdit` now persists `metadata.error` so a repeat failure is diagnosable from the card itself), and tells the customer the team will apply it. Same pattern the [[cancel]] save surface already uses.
- **A human always owns the promise** (`ensureJourneyFollowUpTicket`): a reminder session is minted with `ticket_id` null ([[../libraries/pre-renewal-reminders]] `sendTreatmentReminder`), so "our team will take care of it" used to point at nothing. On a failed/unresolvable edit the route now creates (or reuses) a ticket for the session's customer and stamps it on `journey_sessions.ticket_id` before raising the notification.
- **Lifecycle events**: `opened` (GET loader), `edited` / `skipped` (`/edit`), `cancelled` / `saved` (`/complete`) are written to [[../tables/journey_step_events]] keyed by the `journey_sessions` row (`step_key='lifecycle'`, `response_value=<event>`) so the M3 harness + M4 dashboard can join engagement to the experiment arm.

## Files

- `src/lib/next-order-journey-builder.ts` — steps + metadata (single source of truth); shared catalog + engine prices
- `src/lib/portal/editable-catalog.ts` — shared swap/add catalog + consumable/in-stock rule ([[../libraries/portal__editable-catalog]])
- `src/lib/subscription-frequency.ts` — shared frequency sequence ([[../libraries/subscription-frequency]])
- `src/lib/journey-step-builder.ts` — `next_order` switch case
- `src/app/api/journey/[token]/edit/route.ts` — edit dispatch + Portal-parity guards + `ensureJourneyFollowUpTicket`
- `src/app/api/journey/[token]/price-quote/route.ts` — journey price quote (mirrors the Portal's, session-scoped)
- `src/app/api/journey/[token]/route.ts` — GET loader flags `nextOrderJourney`, pre-selects sub, emits `opened`
- `src/app/api/journey/[token]/remedies` + `/complete` — reused for in-journey cancel + saves
- `src/app/journey/[token]/page.tsx` — `NextOrderJourney` editor renderer
- Migration: `supabase/migrations/20261119123000_next_order_journey.sql`
