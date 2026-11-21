# `src/lib/reactivate-journey-builder.ts`

**The one-click win-back journey** — a single terminal `single_choice` step ("Yes, restart my subscription" / "Not right now") rendered at `/journey/{token}` for a customer whose subscription is cancelled or paused. The token IS the authentication; no login.

Routed from [[journey-step-builder]] for journey types `win_back`, `reactivate`, `reactivate_subscription` (definition slug `reactivate-subscription`). First used by `scripts/winback-mixed-berry.ts` (Mixed Berry crisis win-back, 2026-07-30 → 10-15: 198 recipients, 13% placed a sub order after).

## Exports

| Export | What |
|---|---|
| `buildReactivateSteps(admin, ws, customerId, ticketId)` | Builds the step config + metadata (`subscriptionId`, `contractId`, `previousStatus`). Empty config when the customer has no cancelled/paused sub. |
| `resolveTargetSubscription(admin, ws, customerId)` | The sub to restart: newest paused, else newest cancelled, across the `customer_links` group. Also used by [[../inngest/journey-outcomes]] when the session has no `subscription_id`. |
| `isReactivateChoice(outcome, responses)` | Pure. True on outcome `reactivated` OR answer `reactivate_choice = reactivate`. Pinned by `src/lib/reactivate-journey-builder.test.ts`. |

## Execution

The click is executed by [[../inngest/journey-outcomes]] `journey-session-completed` → `subscriptionAction(resume)` ([[commerce__subscription]]). For an Appstle-billed cancelled sub, `ensureShopcxEngine` ([[commerce__shopcx-revive]]) rebuilds it on ShopCX from our mirror at the customer's own price (switch `appstle_retired` on since 2026-10-29). Refusals such as `needs_payment_method` are logged as `winback.reactivate_failed`.

## Gotchas

- The journey page posts `outcome:"completed"`, never `reactivated` — gate on the answer (`isReactivateChoice`), not the outcome label. Before 2026-11-21 the restart never fired.
- Win-back send scripts mint sessions with `customer_id` only; the outcome processor re-resolves the target rather than trusting `session.subscription_id`.

[[../README]] · [[../journeys/README]]
