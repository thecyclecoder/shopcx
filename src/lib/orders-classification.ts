/**
 * orders-classification — Phase 1: classifyOrder facets.
 *
 * A pure classifier over one `orders` row on four orthogonal facets. The two
 * origin/cart-type facets DELEGATE to `bucketOrder` (the SoT for
 * renewal/subscription discrimination — see docs/brain/libraries/order-bucketing.md);
 * this SDK adds the two facets bucketOrder doesn't cover:
 *
 *  - source        — which of the 3 order sources (shopify | internal | amazon)
 *                    the row came from, discriminated from documented tells
 *                    (`source_name`, `shopify_order_id`, `braintree_*`,
 *                    `amplifier_*`, `amazon_order_id`).
 *  - customerRecency — first_time vs repeat customer, defined ONLY for the
 *                      checkout origin. Filled in Phase 2 (needs a DB read);
 *                      left undefined here.
 *
 * Any place in the codebase that needs "first-time vs repeat customer" or
 * "checkout vs renewal" should call `classifyOrder` (or Phase 2's
 * `queryOrders`) instead of hand-rolling predicates against raw columns.
 * See docs/brain/specs/orders-classification-sdk.md.
 */
import { bucketOrder, type OrderBucket } from "./order-bucketing";

export type OrderSource = "shopify" | "internal" | "amazon";
export type OrderOrigin = "checkout" | "renewal";
export type OrderCartType = "subscription" | "one_time";
export type CustomerRecency = "first_time" | "repeat";

/**
 * Minimal orders-row shape classifyOrder reads. All fields are optional so
 * callers can pass a partial select from the orders table; unknown fields
 * default to null and the classifier still returns a well-formed verdict.
 */
export interface ClassifyOrderInput {
  source_name?: string | null;
  tags?: string | string[] | null;
  subscription_id?: string | null;
  shopify_order_id?: string | null;
  braintree_transaction_id?: string | null;
  amplifier_order_id?: string | null;
  amazon_order_id?: string | null;
}

export interface ClassifyOrderResult {
  source: OrderSource;
  origin: OrderOrigin;
  cartType?: OrderCartType;
  customerRecency?: CustomerRecency;
}

export interface ClassifyOrderOptions {
  /**
   * Optional `workspaces.order_source_mapping` — pass-through to
   * `bucketOrder` so custom mappings (numeric Shopify ids → replacement, etc.)
   * still apply to the origin/cartType facets.
   */
  sourceMapping?: Record<string, string>;
}

// source_name values written by internal writers (never by Shopify sync).
// Kept in sync with:
//   • src/app/api/checkout/route.ts            → "storefront"
//   • src/lib/inngest/internal-subscription-renewals.ts →
//       "internal_subscription_renewal" / "internal_subscription_comp_renewal"
//   • src/lib/commerce/order.ts createOrder     → "internal" / "shopcx-created"
const INTERNAL_SOURCE_NAMES = new Set<string>([
  "storefront",
  "internal",
  "internal_subscription_renewal",
  "internal_subscription_comp_renewal",
  "shopcx-created",
]);

// source_name values that mark a row as Amazon-sourced. Amazon revenue mostly
// lives in daily_amazon_order_snapshots, but the orders table can carry an
// Amazon-sourced row when marked explicitly.
const AMAZON_SOURCE_NAMES = new Set<string>(["amazon"]);

function detectSource(order: ClassifyOrderInput): OrderSource {
  const src = (order.source_name || "").toLowerCase();
  if (AMAZON_SOURCE_NAMES.has(src) || order.amazon_order_id) return "amazon";
  if (INTERNAL_SOURCE_NAMES.has(src)) return "internal";
  // No shopify_order_id AND a braintree charge on the row → an internal order
  // whose source_name was never stamped (defensive fallback).
  if (!order.shopify_order_id && order.braintree_transaction_id) return "internal";
  return "shopify";
}

/**
 * Classify one orders row on {source, origin, cartType, customerRecency}.
 *
 * `origin` + `cartType` are derived from `bucketOrder` and MUST NOT be
 * re-derived here — a drift in the renewal predicate would silently corrupt
 * ROAS. Phase 1 does not fill `customerRecency` (Phase 2's queryOrders adds
 * the batched prior-order lookup).
 */
export function classifyOrder(
  order: ClassifyOrderInput,
  options: ClassifyOrderOptions = {},
): ClassifyOrderResult {
  const bucket: OrderBucket = bucketOrder(order, options.sourceMapping ?? {});
  const source = detectSource(order);

  let origin: OrderOrigin;
  let cartType: OrderCartType | undefined;
  if (bucket === "recurring") {
    origin = "renewal";
    cartType = undefined;
  } else if (bucket === "new_sub") {
    origin = "checkout";
    cartType = "subscription";
  } else if (bucket === "one_time") {
    origin = "checkout";
    cartType = "one_time";
  } else {
    // "replacement" — a draft/replacement order. Treat as checkout with no
    // cart-type facet (it is not a subscription creation and not a renewal).
    origin = "checkout";
    cartType = undefined;
  }

  return { source, origin, cartType };
}
