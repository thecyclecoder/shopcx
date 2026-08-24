/**
 * Link a subscription's ORIGINATING checkout order to its `subscriptions` row
 * (`orders.subscription_id`).
 *
 * ## Why this exists
 *
 * A subscription's FIRST order is a normal checkout — Shopify sends it with
 * `source_name = "web"` and a "first subscription" tag. Only RENEWALS carry a
 * `source_name` containing "subscription". The order webhook's linkage block is
 * gated on `sourceName.includes("subscription")`, so it has ALWAYS fired on
 * every renewal and on no first order.
 *
 * That gate is therefore NOT the regression — it was equally false in December
 * 2025, when 159/159 `source_name="web"` first-sub orders still ended up linked.
 * What actually filled the column was the manual CSV subscription import
 * (`inngest/import-subscriptions.ts` — an `import/file.upload` event, NOT a
 * cron), which back-links orders as a side effect. It last ran in March 2026
 * (~27,786 subscriptions). Nothing has filled the column since: 1,013 orders
 * between 2026-04-01 and 2026-08-24 sit unlinked, 100% of which have a
 * resolvable `subscriptions` row.
 *
 * So the real defect is that a routine invariant depended on a human running an
 * import. That silently corrupts two things:
 *  - [[order-bucketing]] `bucketOrder` falls back to `subscription_id` for
 *    INTERNAL storefront orders (they carry no Shopify tag), so those new subs
 *    bucket as `one_time` instead of `new_sub`.
 *  - Any orders → subscriptions join reads empty.
 *
 * ## Why both webhooks call this
 *
 * The two rows are created by two independent webhooks — Shopify sends the
 * order, Appstle sends the subscription — and neither is guaranteed to land
 * first. Measured on the 1,013 stranded orders, our `subscriptions` row is
 * inserted after the order's Shopify timestamp in every case (1,010 within five
 * minutes), but that is a proxy for arrival order, not proof of it.
 *
 * Rather than depend on the ordering, BOTH handlers call this: the Appstle
 * handler after its subscription upsert, and the Shopify order handler behind a
 * widened gate. Whichever lands second finds both rows and links them; the one
 * that lands first no-ops. The compare-and-set UPDATE makes the double call
 * safe.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";

type Admin = ReturnType<typeof createAdminClient>;

/** How far back from a subscription to look for its originating order. */
export const LINK_LOOKBACK_MS = 24 * 3600_000;
/** How far forward — a small grace for clock skew between Shopify and Appstle. */
export const LINK_LOOKAHEAD_MS = 60 * 60_000;

export interface LinkCandidateOrder {
  id: string;
  created_at: string;
  tags: string | string[] | null;
  source_name: string | null;
  line_items: unknown;
}

export interface SubscriptionItemLike {
  sku?: string | null;
}

export interface LinkResult {
  linked: boolean;
  orderId?: string;
  /** How the match was made — recorded so a wrong link is diagnosable. */
  reason: "sku_match" | "sole_candidate" | "no_candidate" | "ambiguous" | "error";
  candidatesConsidered: number;
}

/** Normalize Shopify's comma-joined tag string (or an array) to lowercase tokens. */
export function tagTokens(tags: string | string[] | null | undefined): string[] {
  if (!tags) return [];
  const list = Array.isArray(tags) ? tags : String(tags).split(",");
  return list.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
}

/** Does this order look like the FIRST order of a subscription? */
export function isFirstSubscriptionOrder(order: {
  tags?: string | string[] | null;
  source_name?: string | null;
}): boolean {
  if (tagTokens(order.tags).some((t) => t.includes("first subscription"))) return true;
  // Internal storefront orders carry no Shopify tag; they're `storefront`-sourced
  // and reach us only through the checkout path, so treat them as eligible too.
  const src = String(order.source_name ?? "").toLowerCase();
  return src === "storefront";
}

/** SKUs on an order's line items. */
export function orderSkus(lineItems: unknown): Set<string> {
  const out = new Set<string>();
  for (const li of (Array.isArray(lineItems) ? lineItems : []) as Array<Record<string, unknown>>) {
    const sku = String(li.sku ?? "").trim();
    if (sku) out.add(sku);
  }
  return out;
}

/**
 * Choose which candidate order belongs to this subscription. PURE — no DB, no
 * clock — so the matching rules are unit-pinnable.
 *
 * Deliberately conservative: a SKU overlap wins outright; with no overlap we
 * only link when there is exactly ONE candidate, because a customer who starts
 * two subscriptions in the same window would otherwise get an arbitrary
 * assignment. Ambiguity is left unlinked rather than guessed — a wrong
 * `subscription_id` is worse than a null one (it corrupts bucketing AND the
 * subscription's own order history).
 */
export function chooseOrderForSubscription(
  candidates: LinkCandidateOrder[],
  subItems: SubscriptionItemLike[],
): LinkResult {
  const eligible = candidates.filter(isFirstSubscriptionOrder);
  if (eligible.length === 0) {
    return { linked: false, reason: "no_candidate", candidatesConsidered: candidates.length };
  }

  const subSkus = new Set(
    subItems.map((i) => String(i?.sku ?? "").trim()).filter(Boolean),
  );
  if (subSkus.size > 0) {
    const bySku = eligible.filter((o) => {
      const skus = orderSkus(o.line_items);
      for (const s of skus) if (subSkus.has(s)) return true;
      return false;
    });
    if (bySku.length === 1) {
      return { linked: true, orderId: bySku[0].id, reason: "sku_match", candidatesConsidered: eligible.length };
    }
    if (bySku.length > 1) {
      // Same SKU on two orders — take the earliest, that's the originating one.
      const earliest = [...bySku].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
      return { linked: true, orderId: earliest.id, reason: "sku_match", candidatesConsidered: eligible.length };
    }
  }

  if (eligible.length === 1) {
    return { linked: true, orderId: eligible[0].id, reason: "sole_candidate", candidatesConsidered: 1 };
  }
  return { linked: false, reason: "ambiguous", candidatesConsidered: eligible.length };
}

/**
 * Find and link the originating order for one subscription.
 *
 * Idempotent: only ever fills a NULL `subscription_id` (the candidate query is
 * `.is("subscription_id", null)`), so re-running can't move an existing link.
 */
export async function linkOriginatingOrder(
  admin: Admin,
  args: {
    workspaceId: string;
    subscriptionId: string;
    shopifyCustomerId: string | null;
    subItems?: SubscriptionItemLike[];
    /** Anchor the search window — the subscription's creation time. */
    anchorIso?: string | null;
  },
): Promise<LinkResult> {
  if (!args.shopifyCustomerId) {
    return { linked: false, reason: "no_candidate", candidatesConsidered: 0 };
  }
  try {
    const anchorMs = args.anchorIso ? Date.parse(args.anchorIso) : Date.now();
    const from = new Date(anchorMs - LINK_LOOKBACK_MS).toISOString();
    const to = new Date(anchorMs + LINK_LOOKAHEAD_MS).toISOString();

    const { data, error } = await admin
      .from("orders")
      .select("id,created_at,tags,source_name,line_items")
      .eq("workspace_id", args.workspaceId)
      .eq("shopify_customer_id", args.shopifyCustomerId)
      .is("subscription_id", null)
      .gte("created_at", from)
      .lte("created_at", to)
      .order("created_at", { ascending: true })
      .limit(50);
    if (error) throw new Error(error.message);

    const choice = chooseOrderForSubscription((data ?? []) as LinkCandidateOrder[], args.subItems ?? []);
    if (!choice.linked || !choice.orderId) return choice;

    const { error: upErr } = await admin
      .from("orders")
      .update({ subscription_id: args.subscriptionId })
      .eq("id", choice.orderId)
      .is("subscription_id", null); // compare-and-set: never clobber an existing link
    if (upErr) throw new Error(upErr.message);
    return choice;
  } catch (e) {
    console.error(`[subscription-order-link] failed: ${errText(e)}`);
    return { linked: false, reason: "error", candidatesConsidered: 0 };
  }
}
