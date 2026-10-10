/**
 * Quantity break (Buy 2 / Buy 3) and Subscribe & Save, as one product discount.
 *
 * Replaces Shopify's native "Buy 2 Discount" / "Buy 3 Discount" and, once the
 * selling plans lose their own 25%, the plan's Subscribe & Save. Shopify gives a
 * cart line only ONE product discount (the largest), so each automatic discount
 * on this function returns the line's whole percentage:
 *
 *   tier         = `percentage` when eligible units in the cart total `minQuantity`+, else 0
 *   one-time     = tier
 *   subscription = 1 - (1 - subscriptionPercentage) * (1 - tier)   (25% off, then the tier)
 *
 * One automatic discount per tier ("Buy 2 Discount", "Buy 3 Discount") plus one
 * with minQuantity 1 and percentage 0 for subscription lines below Buy 2. Each is
 * configured through its `$app:function-configuration` metafield; where several
 * match a line, Shopify keeps the largest. `subscriptionPercentage` defaults to 0,
 * so nothing changes until the cutover sets it.
 *
 * The tier counts only `productIds` (the native Buy 2/3 list). The subscription
 * part covers any selling-plan line except `excludeProductIds` (Shipping
 * Protection, which is priced at $4.95 directly), optionally limited to
 * `sellingPlanIds`. Free gift lines (line property
 * `_free_gift`) neither count nor get discounted.
 *
 * Discount titles must stay "Buy N Discount": ShopCX code reads them off orders
 * and contracts.
 */

export const DEFAULT_CONFIG = {
  // The native Buy 2 / Buy 3 product list (2026-10-08).
  productIds: [
    "gid://shopify/Product/7465708093613", // Superfood Tabs
    "gid://shopify/Product/7465715826861", // Amazing Coffee
    "gid://shopify/Product/7467657887917", // Amazing Creamer
    "gid://shopify/Product/7467662016685", // Ashwavana Guru Focus
    "gid://shopify/Product/7467668013229", // Ashwavana Zen Relax
    "gid://shopify/Product/7467693047981", // ACV Gummies
    "gid://shopify/Product/7467693670573", // Sleep Gummies
    "gid://shopify/Product/7467749965997", // Amazing Coffee Pods (K-Cups)
    "gid://shopify/Product/8238402896045", // Creatine Prime+
  ],
  excludeProductIds: ["gid://shopify/Product/8356945952941"], // Shipping Protection
  minQuantity: 2,
  percentage: 8,
  subscriptionPercentage: 0,
  // Selling plan gids that get subscriptionPercentage; null = any selling plan.
  // Set to ShopCX's own plans at cutover so a plan that still carries its own
  // pricing policy (Appstle's 25%) can never get a second 25%.
  sellingPlanIds: null,
};

const EMPTY = { operations: [] };

export function cartLinesDiscountsGenerateRun(input) {
  if (!input.discount.discountClasses.includes("PRODUCT")) return EMPTY;

  const config = { ...DEFAULT_CONFIG, ...(input.discount.metafield?.jsonValue ?? {}) };
  const sns = Number(config.subscriptionPercentage) || 0;
  const tierPct = Number(config.percentage) || 0;

  const lines = input.cart.lines.filter(
    (line) =>
      line.merchandise.__typename === "ProductVariant" &&
      !config.excludeProductIds.includes(line.merchandise.product.id) &&
      !line.giftTag?.value,
  );
  const inTier = (line) => config.productIds.includes(line.merchandise.product.id);
  const quantity = lines.filter(inTier).reduce((sum, line) => sum + line.quantity, 0);
  // A tier discount stays out until its tier is met (the subscription-only discount,
  // percentage 0, covers subscription lines below it).
  if (tierPct > 0 && quantity < config.minQuantity) return EMPTY;

  // Line id groups by percentage: a candidate carries one value.
  const byPct = new Map();
  for (const line of lines) {
    const tier = inTier(line) ? tierPct : 0;
    const planId = line.sellingPlanAllocation?.sellingPlan.id;
    const snsApplies = planId && (!config.sellingPlanIds || config.sellingPlanIds.includes(planId));
    const pct = snsApplies ? 100 - ((100 - sns) * (100 - tier)) / 100 : tier;
    const value = Math.round(pct * 100) / 100;
    if (!(value > 0)) continue;
    if (!byPct.has(value)) byPct.set(value, []);
    byPct.get(value).push(line.id);
  }
  if (byPct.size === 0) return EMPTY;

  const message =
    config.message ?? (tierPct > 0 ? `Buy ${config.minQuantity} Discount` : "Subscription Discount");

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates: [...byPct].map(([value, ids]) => ({
            message,
            targets: ids.map((id) => ({ cartLine: { id } })),
            value: { percentage: { value } },
          })),
          selectionStrategy: "ALL",
        },
      },
    ],
  };
}
