# libraries/winback-reactivate-choice

Executes the win-back journey's "Yes, restart my subscription" / "Not right now" click and returns
the real result for the page to show.

**File:** `src/lib/winback-reactivate-choice.ts` · test: `npm run test:winback-reactivate-choice`

## Exports

- `REACTIVATE_JOURNEY_TYPES` — `reactivate_subscription`, `reactivate`, `win_back`.
- `winbackChoiceFrom(journeyType, responses)` → the `reactivate_choice` value, or null. A minted
  win-back session's frozen `config_snapshot` has no journeyType, so the unique step key is the signal;
  another journey type carrying the key is ignored.
- `handleReactivateChoice(admin, session, choice, responses)` → `{ outcome, message }`. Resolves the
  target sub ([[reactivate-journey-builder]] `resolveTargetSubscription`), restarts it with
  [[subscription-reactivate]], completes the session (`outcome_action_taken: true`, `subscription_id`),
  writes a ticket note (if the session has a ticket) and a `winback.reactivated` /
  `winback.reactivate_failed` customer event.

## Callers

`src/app/api/journey/[token]/complete/route.ts` (before the code-driven block, returns early) and
`src/app/api/journey/[token]/step/route.ts`.

## Outcomes

`reactivated`, `declined`, `reactivate_needs_payment_method`, `reactivate_needs_address`,
`reactivate_failed`, `error_no_target_sub`.
