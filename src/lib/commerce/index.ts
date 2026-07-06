/**
 * src/lib/commerce — the single SDK for every commerce entity.
 *
 * The M2 goal: one SDK, one money resolver (./price.ts), zero surfaces rendering
 * $NaN / $0 / undefined cents. Consumers (dashboard commerce pages, ticket
 * detail, agent Improve tab, AI stack, mini-site portal, shopify-extension
 * portal) import from `@/lib/commerce` — never from a per-surface hydration
 * helper — so display and mutation share one contract.
 *
 * Phase 1 scaffolds the package (view shapes + typed module stubs); operation
 * implementations arrive in M2b (Display) and M2c (Mutation).
 */

export * from "./types";

export * as price from "./price";
export * as subscription from "./subscription";
export * as order from "./order";
export * as returnOp from "./return";
export * as replacement from "./replacement";
export * as customer from "./customer";
export * as loyalty from "./loyalty";
export * as chargeback from "./chargeback";
export * as fraud from "./fraud";
export * as crisis from "./crisis";
export * as refund from "./refund";
