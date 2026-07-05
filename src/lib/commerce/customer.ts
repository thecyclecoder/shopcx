/**
 * commerce/customer.ts — Display + Mutation ops for customers.
 *
 * Phase 1 declares the surface; implementations arrive in M2b / M2c. Consumers
 * expand linked accounts with `linkedIds(customerId)` before every read — the
 * Display op takes a single `customer_id` and does that expansion internally so
 * surfaces cannot forget it.
 *
 * Canonical view: `CustomerView` in `./types.ts`.
 */

export type { CustomerView } from "./types";
