# libraries/reactivate-journey-builder

The one-click win-back journey (journey slug `reactivate-subscription`, journey types
`win_back` / `reactivate` / `reactivate_subscription` in [[journey-step-builder]]).

**File:** `src/lib/reactivate-journey-builder.ts`

## Exports

- `buildReactivateSteps(admin, workspaceId, customerId, ticketId)` → a single terminal
  `single_choice` step `reactivate_choice` with options `reactivate` / `not_now`.
- `resolveTargetSubscription(admin, workspaceId, customerId)` → the customer's paused sub, else
  their most recently updated cancelled sub, across the linked-account group.

## How the click is executed

Single-step, so the page posts to `/api/journey/[token]/step`. That route handles
`stepKey === "reactivate_choice"` synchronously via [[subscription-reactivate]] (same path as the
portal Reactivate button) and returns the real result message. First order processes tomorrow.

## Gotchas

- Before 2026-11-21 the click was only recorded; nothing restarted (see [[subscription-reactivate]]).
- The session minted by `scripts/winback-mixed-berry.ts` does not set `subscription_id`; the target
  is resolved at click time from the customer.
