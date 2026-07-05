/**
 * commerce/order.ts — Display + Mutation ops for orders.
 *
 * Phase 1 declares the surface; implementations arrive in M2b / M2c. An order is
 * a historical record — pricing is snapshotted at renewal time onto the row's
 * line items, so the Display op reads them as-is and does NOT re-price through
 * `./price.ts`.
 *
 * Canonical view: `OrderView` in `./types.ts`.
 */

export type { OrderView, OrderLineView } from "./types";
