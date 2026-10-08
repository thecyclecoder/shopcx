/**
 * Quantity break: replaces Shopify's native "Buy 2 Discount" / "Buy 3 Discount".
 *
 * Same rule as the native discounts: when eligible products in the cart total
 * `minQuantity` or more units, every eligible line gets `percentage` off. One
 * automatic discount per tier, each configured through its
 * `$app:function-configuration` metafield ({ minQuantity, percentage }); where
 * two tiers match a line, Shopify keeps the larger, as it did natively.
 *
 * The one difference: free gift lines (line property `_free_gift`) neither count
 * toward the quantity nor get discounted, so a free Cinnamon Roll Creamer can't
 * unlock Buy 2 or bump Buy 2 to Buy 3.
 *
 * Subscription and one-time lines both count, as natively. Discount titles must
 * stay "Buy N Discount": ShopCX code reads them off orders and contracts.
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
  minQuantity: 2,
  percentage: 8,
};

const EMPTY = { operations: [] };

export function cartLinesDiscountsGenerateRun(input) {
  if (!input.discount.discountClasses.includes("PRODUCT")) return EMPTY;

  const config = { ...DEFAULT_CONFIG, ...(input.discount.metafield?.jsonValue ?? {}) };
  if (!(config.percentage > 0)) return EMPTY;
  const message = config.message ?? `Buy ${config.minQuantity} Discount`;

  const eligible = input.cart.lines.filter(
    (line) =>
      line.merchandise.__typename === "ProductVariant" &&
      config.productIds.includes(line.merchandise.product.id) &&
      !line.giftTag?.value,
  );
  const quantity = eligible.reduce((sum, line) => sum + line.quantity, 0);
  if (quantity < config.minQuantity) return EMPTY;

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates: [
            {
              message,
              targets: eligible.map((line) => ({ cartLine: { id: line.id } })),
              value: { percentage: { value: config.percentage } },
            },
          ],
          selectionStrategy: "FIRST",
        },
      },
    ],
  };
}
