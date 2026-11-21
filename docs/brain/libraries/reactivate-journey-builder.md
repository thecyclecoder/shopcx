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
- `resolveTargetSubscription(admin, workspaceId, customerId)` → the customer's paused sub, else
  their most recently updated cancelled sub, across the linked-account group.

## How the click is executed

The page treats any journey with a `steps` array as multi-step, so it posts `/complete`
(outcome `completed`). [[winback-reactivate-choice]] handles it there (and on `/step`)
synchronously via [[subscription-reactivate]] (same path as the portal Reactivate button) and
returns the real result message. First order processes tomorrow.

## Gotchas

- Before 2026-11-21 nothing restarted on click (see [[subscription-reactivate]] § Gotchas).
- The session minted by `scripts/winback-mixed-berry.ts` does not set `subscription_id`; the target
  is resolved at click time from the customer.
