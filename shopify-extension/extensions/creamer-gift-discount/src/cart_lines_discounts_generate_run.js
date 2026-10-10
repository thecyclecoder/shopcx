/**
 * Free Cinnamon Roll Creamer with Amazing Coffee K-Cups.
 *
 * Makes ONE unit of the gift creamer line free when the cart qualifies:
 * any K-Cups line on a subscription (selling plan), or 2+ K-Cups boxes in total.
 *
 * Only a one-time line tagged `_free_gift=cinnamon-roll-creamer` (the line the
 * theme cart script adds) is discounted, so a creamer the shopper buys on
 * purpose, or a creamer subscription, is never made free. The gift is one-time,
 * so it never joins a subscription contract and never repeats on renewals.
 *
 * Defaults are the production ids; the discount's `$app:function-configuration`
 * metafield can override any of them without a redeploy.
 */

export const DEFAULT_CONFIG = {
  qualifyingProductIds: ["gid://shopify/Product/7467749965997"], // Amazing Coffee K-Cups
  giftVariantId: "gid://shopify/ProductVariant/43512521523373", // Amazing Creamer, Cinnamon Roll
  giftTag: "cinnamon-roll-creamer",
  minQuantity: 2,
  message: "Free Cinnamon Roll Creamer",
};

const EMPTY = { operations: [] };

export function cartLinesDiscountsGenerateRun(input) {
  if (!input.discount.discountClasses.includes("PRODUCT")) return EMPTY;

  const config = { ...DEFAULT_CONFIG, ...(input.discount.metafield?.jsonValue ?? {}) };
  const lines = input.cart.lines;

  let qualifyingQuantity = 0;
  let hasSubscription = false;
  for (const line of lines) {
    const variant = line.merchandise;
    if (variant.__typename !== "ProductVariant") continue;
    if (!config.qualifyingProductIds.includes(variant.product.id)) continue;
    qualifyingQuantity += line.quantity;
    if (line.sellingPlanAllocation) hasSubscription = true;
  }
  if (!hasSubscription && qualifyingQuantity < config.minQuantity) return EMPTY;

  const giftLine = lines.find(
    (line) =>
      line.merchandise.__typename === "ProductVariant" &&
      line.merchandise.id === config.giftVariantId &&
      line.giftTag?.value === config.giftTag &&
      !line.sellingPlanAllocation,
  );
  if (!giftLine) return EMPTY;

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates: [
            {
              message: config.message,
              targets: [{ cartLine: { id: giftLine.id, quantity: 1 } }],
              value: { percentage: { value: 100 } },
            },
          ],
          selectionStrategy: "FIRST",
        },
      },
    ],
  };
}
