/**
 * commerce/chargeback.ts — Display + Mutation ops for chargebacks.
 *
 * Phase 1 declares the surface; implementations arrive in M2b / M2c. Sub
 * cancellations from `auto_action_taken='subscriptions_cancelled'` live in
 * `chargeback_subscription_actions` keyed by `chargeback_event_id` — the Display
 * op joins them so the view carries WHICH subs were cancelled, not just that
 * SOMETHING was.
 *
 * Canonical view: `ChargebackView` in `./types.ts`.
 */

export type { ChargebackView } from "./types";
