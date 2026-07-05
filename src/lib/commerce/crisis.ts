/**
 * commerce/crisis.ts — Display + Mutation ops for out-of-stock crises.
 *
 * Phase 1 declares the surface; implementations arrive in M2b / M2c. A crisis is
 * an event + per-customer tier state (`crisis_customer_actions`) — the Display
 * op rolls them into one view so surfaces don't re-join.
 *
 * Canonical view: `CrisisView` in `./types.ts`.
 */

export type { CrisisView, CrisisCustomerActionView } from "./types";
