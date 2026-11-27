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
  `winback.reactivate_failed` customer event. If the choice carries a gift, it is honoured ONLY when
  the variant is on `loadWinbackGifts`, resolved to a Shopify id (`resolveShopifyVariantId`) and added
  with `subscriptionAddFreeProduct` (one-time $0 line on the first order). A failed gift add never
  undoes the restart: the ticket note flags it for manual add and the event records `gift_error`.

## Callers

`src/app/api/journey/[token]/complete/route.ts` (before the code-driven block, returns early) and
`src/app/api/journey/[token]/step/route.ts`.

## Outcomes

`reactivated`, `declined`, `reactivate_needs_payment_method`, `reactivate_needs_address`,
`reactivate_failed`, `error_no_target_sub`.

## Fraud / ban / chargeback gate (2026-11-21)

`winbackBlockReason(admin, workspaceId, customerId)` → reason string or null. Blocks confirmed fraud,
reseller flags, `banned` (any linked profile), active chargebacks (all via
[[customer-fraud-status]] `getCustomerFraudStatus` + `shouldBlockOrchestrator`, the orchestrator's gate)
plus `customers.portal_banned`. `handleReactivateChoice` checks it before any restart: a blocked
click ends the session with outcome `blocked_fraud_gate`, writes an internal ticket note, restarts
nothing, adds no gift. Win-back send scripts must call the same function so the audience filter and
the click gate can't diverge (CEO: never send restart offers to banned, fraud or chargeback customers).

**2026-11-22:** the success message and ticket note include any out-of-stock swap made on restart ([[crisis-restart-swap]]).

**2026-11-27 — restart-with-replacement.** When the chosen value is `reactivate_replace` (`parseReactivateValue().replaceDiscontinued`), `handleReactivateChoice` resolves the replacement BEFORE restarting (via [[reactivate-journey-builder]] `subDiscontinuedReplacement` on the sub's current items — they change to the replacement afterwards), passes `replaceDiscontinued` to [[subscription-reactivate]], and renders the shared `replacementResultMessage` / `replacementTicketNote` (identical to the portal). The revive substitutes the discontinued line for the replacement variant at the configured per-unit price. See [[../lifecycles/shopcx-subscriptions]] § Reactivation.
