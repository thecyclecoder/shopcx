/**
 * commerce/refund.ts — Mutation op for refunds.
 *
 * Phase 1 declares the surface; implementations arrive in M2c. Refund money
 * moves through a gateway (`'braintree' | 'shopify'`) — that discriminator is
 * declared on the Gateway union added by Phase 4. The Mutation op MUST resolve
 * cents through `./price.ts`, never a caller-supplied number, so the phantom-
 * refund defect (M1 spec, defect register #1) cannot recur.
 */

export {};
