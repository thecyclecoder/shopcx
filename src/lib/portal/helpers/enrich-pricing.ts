/**
 * DEPRECATED shim — the money resolver moved to `@/lib/commerce/price` as of
 * commerce-sdk-scaffold-money-resolver Phase 2. New code MUST import from
 * `@/lib/commerce/price` (or `@/lib/commerce`); this file only re-exports so
 * today's callers keep resolving during the migration.
 *
 * @deprecated Use `@/lib/commerce/price` instead. This shim will be removed
 * after every caller is migrated to the SDK entrypoint.
 */
export {
  priceSubscription,
  priceSubItemsForDisplay,
  enrichContractPricing,
  PriceInvariantError,
} from "@/lib/commerce/price";
export type { ContractPricing, PricedLineLite } from "@/lib/commerce/price";
