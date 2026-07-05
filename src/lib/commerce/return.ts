/**
 * commerce/return.ts — Display + Mutation ops for returns.
 *
 * Phase 1 declares the surface; implementations arrive in M2b / M2c. Returns
 * refund on EasyPost `delivered` (not carrier first-scan), and `net_refund_cents`
 * is set at creation and MUST be trusted at refund time — the Mutation op
 * enforces that invariant.
 *
 * Canonical view: `ReturnView` in `./types.ts`.
 */

export type { ReturnView, ReturnLineView } from "./types";
