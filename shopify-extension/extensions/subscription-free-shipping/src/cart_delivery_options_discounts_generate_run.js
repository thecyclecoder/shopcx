/**
 * Free Economy shipping with subscriptions.
 *
 * When any cart line is on a subscription (has a selling plan), the delivery
 * option titled "Economy" in every delivery group is 100% off. Standard and
 * Express stay paid.
 *
 * Replaces Shopify's native "Free Shipping on Subscriptions" discounts, which
 * (a) stop applying the moment the cart also holds a one-time item, such as the
 * free creamer gift or a cart add-on, and (b) can only cap by rate price, so they
 * freed Standard and Express too.
 *
 * Defaults are production values; the discount's `$app:function-configuration`
 * metafield can override them without a redeploy.
 */

export const DEFAULT_CONFIG = {
  optionTitles: ["Economy"],
  message: "Free shipping with your subscription",
};

const EMPTY = { operations: [] };

export function cartDeliveryOptionsDiscountsGenerateRun(input) {
  if (!input.discount.discountClasses.includes("SHIPPING")) return EMPTY;

  const config = { ...DEFAULT_CONFIG, ...(input.discount.metafield?.jsonValue ?? {}) };
  const hasSubscription = input.cart.lines.some((line) => line.sellingPlanAllocation);
  if (!hasSubscription) return EMPTY;

  const titles = config.optionTitles.map((title) => title.trim().toLowerCase());
  const targets = [];
  for (const group of input.cart.deliveryGroups) {
    for (const option of group.deliveryOptions) {
      if (titles.includes((option.title ?? "").trim().toLowerCase())) {
        targets.push({ deliveryOption: { handle: option.handle } });
      }
    }
  }
  if (!targets.length) return EMPTY;

  return {
    operations: [
      {
        deliveryDiscountsAdd: {
          candidates: [{ message: config.message, targets, value: { percentage: { value: 100 } } }],
          selectionStrategy: "ALL",
        },
      },
    ],
  };
}
