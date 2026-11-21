# libraries/reactivate-journey-builder

The one-click win-back journey (journey slug `reactivate-subscription`, journey types
`win_back` / `reactivate` / `reactivate_subscription` in [[journey-step-builder]]).

**File:** `src/lib/reactivate-journey-builder.ts`

## Exports

- `buildReactivateSteps(admin, workspaceId, customerId, ticketId)` → a single terminal
  `single_choice` step `reactivate_choice`. With gifts configured: one option per gift
  (`reactivate:<variant uuid>`, "Restart + free {label}") plus `not_now`; without: `reactivate` / `not_now`.
- `loadWinbackGifts(admin, workspaceId)` → `{ variant_id, label }[]` from
  `journey_definitions.config.winback_gifts` on the active win-back journey (DB-driven; seeded by
  migration `20270121120000_winback_gift_options.sql`: Ashwavana Strawberry, Creatine Prime+ Piña
  Colada, Cinnamon Roll Creamer — excess inventory, CEO 2026-11-21).
- `giftOptionValue(variantId)` / `parseReactivateValue(value)` → `{ restart, giftVariantId }`.
- `resolveTargetSubscription(admin, workspaceId, customerId, preferredSubscriptionId?)` → the
  session's bound `subscription_id` when it is still cancelled/paused in the customer's linked-account
  group; otherwise a paused sub with real items, else the most recently updated cancelled sub with
  real items. Pure rule: `pickTargetSubscription(subs, preferredId)`.
- `isProtectionLine(item)` / `hasRealItems(items)` → shipping protection (SKU `Insure01`, matched
  case-insensitively, or title "Shipping Protection") is an add-on, never a product: it is left out
  of the item summary and a protection-only sub is never picked as the restart target.

## How the click is executed

The page treats any journey with a `steps` array as multi-step, so it posts `/complete`
(outcome `completed`). [[winback-reactivate-choice]] handles it there (and on `/step`)
synchronously via [[subscription-reactivate]] (same path as the portal Reactivate button) and
returns the real result message. First order processes tomorrow.

## Gotchas

- Before 2026-11-21 nothing restarted on click (see [[subscription-reactivate]] § Gotchas).
- The session minted by `scripts/winback-mixed-berry.ts` does not set `subscription_id`; the target
  is resolved at click time from the customer.
- Until 2026-11-21 (post-#3728) the page and the click IGNORED `journey_sessions.subscription_id`,
  so a customer with several cancelled/paused subs could be emailed about one sub and restart
  another (CEO test: email named Creatine, page restarted a paused Shipping-Protection-only sub).
  The protection filter was also case-sensitive (`startsWith("insure")` vs real SKU `Insure01`).
  `GET /api/journey/[token]` now passes `session.subscription_id` through `buildJourneySteps`, and
  `/step` + `/complete` pass it into [[winback-reactivate-choice]].
