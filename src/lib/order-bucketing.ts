/**
 * Canonical order → revenue bucket, shared by the daily-order-snapshot cron
 * and the ROAS route's live "today" query so the two paths can't drift.
 *
 * Buckets:
 *  - recurring    Subscription renewals — Shopify `subscription_contract*` and
 *                 internal `internal_subscription_renewal`. Excluded from ROAS revenue.
 *  - new_sub      A checkout that created/joined a subscription.
 *  - one_time     A checkout with no subscription.
 *  - replacement  Draft / replacement orders. Excluded from ROAS + totals.
 *
 * New-sub detection: Shopify checkouts carry a "first subscription" tag.
 * Internal storefront orders carry NO such tag (they're written by
 * /api/checkout with source_name="storefront" and no tags), so we use
 * `subscription_id` as the new-sub signal for them — a storefront order
 * with a subscription_id created/joined a sub; without one it's one-time.
 *
 * Why this exists: internal renewals used to be bucketed recurring by the
 * snapshot but one-time by the live ROAS query (which only special-cased
 * `subscription_contract_checkout_one`), so internal renewal revenue
 * inflated today's ROAS. And internal storefront subs were counted as
 * one-time everywhere. Both are fixed by routing through this one function.
 */
export type OrderBucket = "recurring" | "new_sub" | "one_time" | "replacement";

export function bucketOrder(
  order: { source_name?: string | null; tags?: string | string[] | null; subscription_id?: string | null },
  sourceMapping: Record<string, string> = {},
): OrderBucket {
  const src = order.source_name || "unknown";
  const mapped = sourceMapping[src];
  const tagList = Array.isArray(order.tags) ? order.tags : typeof order.tags === "string" ? [order.tags] : [];
  const hasFirstSub = tagList.some((t) => String(t).toLowerCase().includes("first subscription"));
  const hasSub = !!order.subscription_id;

  // Recurring: explicit mapping, or any subscription-renewal source
  // (`subscription_contract`, `subscription_contract_checkout_one`,
  // `internal_subscription_renewal` — all contain "subscription").
  if (mapped === "recurring" || src.includes("subscription")) return "recurring";
  if (mapped === "replacement" || src === "shopify_draft_order") return "replacement";

  // Checkout family (mapped "checkout", web/pos/tiktok/walmart, internal
  // "storefront", or unmapped). New sub if it created/joined a subscription.
  return hasFirstSub || hasSub ? "new_sub" : "one_time";
}
