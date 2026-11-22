/**
 * subscription-reactivate — the ONE reactivation path shared by the portal and the journey mini-site.
 *
 * Before this existed, only the portal (`portal/handlers/reactivate.ts`) could restart a cancelled
 * or paused subscription. The win-back journey (`reactivate-journey-builder.ts`) showed a
 * "Yes, restart my subscription" button, but the single-step journey only RECORDED the click
 * (`/api/journey/[token]/step`) — no outcome was ever emitted, and the outcome handler keyed on a
 * `session.subscription_id` the win-back mint never set. Customers were told "we'll email you" and
 * nothing restarted. Rule (CEO 2026-11-16): cancels, saves and account management exist on two
 * surfaces and must stay in sync — so both surfaces now call this function.
 *
 * The implementation lives in the commerce SDK (`@/lib/commerce/subscription`) because it resolves
 * `billing_source` and branches across internal | appstle | shopcx — engine dispatch is the SDK's
 * sole responsibility (check-vendor-dispatch-in-sdk). This module re-exports it so every existing
 * caller (`@/lib/subscription-reactivate`) is unchanged.
 */
export {
  reactivateSubscription,
  defaultReactivationDate,
  type ReactivateFailureReason,
  type ReactivateResult,
} from "@/lib/commerce/subscription";
