/**
 * commerce/loyalty.ts — Display + Mutation ops for loyalty.
 *
 * Phase 1 declares the surface; implementations arrive in M2b / M2c. Balance
 * mutators re-read the live row before writing (see `src/lib/loyalty.ts` gotcha)
 * — the Mutation op wraps that discipline so callers never trust a stale
 * `member` snapshot.
 *
 * Canonical view: `LoyaltyView` in `./types.ts`.
 */

export type { LoyaltyView, LoyaltyRedemptionTierView } from "./types";
