/**
 * commerce/subscription.ts — Display + Mutation ops for subscriptions.
 *
 * Phase 1 declares the surface; Phase 4 adds the DisplayOp / MutationOp interfaces
 * these will satisfy. Implementations arrive in M2b / M2c and cover both branches:
 * internal (engine-priced via `./price.ts`) and Appstle-baked (baked line prices,
 * boundary calls in `src/lib/appstle.ts`).
 *
 * Canonical view: `SubscriptionView` in `./types.ts`.
 */

export type { SubscriptionView, SubscriptionLineView, SubscriptionPricingView } from "./types";
