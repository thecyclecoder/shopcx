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

/** A renewal-order line or sub item, as far as renewal matching needs it. */
export interface RenewalMatchLine {
  sku?: unknown;
  title?: unknown;
}

/** Shipping protection is a shared add-on line, so it never identifies WHICH sub renewed. */
function isProtectionLine(l: RenewalMatchLine): boolean {
  return String(l.title ?? "").toLowerCase().includes("shipping protection");
}

/**
 * Choose which of a customer's subscriptions a RENEWAL order belongs to, from SKUs alone. PURE.
 *
 * Used only when the order carries no contract id (ShopCX-billed renewals have no Appstle
 * metafield). The old rule took the FIRST sub sharing ANY SKU, and Shipping Protection's SKU is on
 * most subs, so a customer with two subs got the renewal pinned to the wrong one: 2026-11-20
 * SC142618 (Coffee Pods + protection) landed on their Superfood Tabs + protection sub, and
 * 2026-11-12 SC142137 on a pods-only sibling. Each sub that actually renewed then read as a month
 * late in the drift monitor and lost the order from its history.
 *
 * Ranking: most overlapping NON-protection SKUs, then most overlapping SKUs overall, then an exact
 * SKU-set match. A sub with no non-protection overlap never matches. A tie at the top stays
 * unlinked, because a wrong `subscription_id` is worse than a null one.
 */
export function chooseSubscriptionForRenewalOrder<S extends { id: string; items: unknown }>(
  orderLines: RenewalMatchLine[],
  subs: S[],
): S | null {
  const skuOf = (l: RenewalMatchLine) => String(l.sku ?? "").trim();
  const orderAll = new Set(orderLines.map(skuOf).filter(Boolean));
  const orderCore = new Set(orderLines.filter((l) => !isProtectionLine(l)).map(skuOf).filter(Boolean));
  if (orderCore.size === 0) return null;
  const scored = subs.map((s) => {
    const items = (Array.isArray(s.items) ? s.items : []) as RenewalMatchLine[];
    const all = new Set(items.map(skuOf).filter(Boolean));
    const core = new Set(items.filter((i) => !isProtectionLine(i)).map(skuOf).filter(Boolean));
    const coreHits = [...core].filter((k) => orderCore.has(k)).length;
    const allHits = [...all].filter((k) => orderAll.has(k)).length;
    const exact = all.size === orderAll.size && allHits === orderAll.size ? 1 : 0;
    return { s, key: [coreHits, allHits, exact] as const };
  }).filter((x) => x.key[0] > 0);
  if (scored.length === 0) return null;
  const cmp = (a: readonly number[], b: readonly number[]) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
  scored.sort((a, b) => cmp(a.key, b.key));
  if (scored.length > 1 && cmp(scored[0].key, scored[1].key) === 0) return null;
  return scored[0].s;
}

/** How close a renewal order lands to the cycle-charge claim that produced it. */
export const RENEWAL_CLAIM_WINDOW_MS = 20 * 60_000;

/**
 * The strongest renewal signal for a ShopCX-billed sub: the renewal worker claims a
 * `subscription_cycle_charges` row for exactly one subscription right before the charge creates the
 * order. PURE. Returns the one sub whose claim falls within `RENEWAL_CLAIM_WINDOW_MS` of the order,
 * or null when none or more than one does. Preferred over SKUs because a customer can edit a sub's
 * items after the order, which makes a later SKU comparison point at the wrong sibling.
 */
export function pickSubscriptionByCycleClaim(
  claims: { subscription_id: string; claimed_at: string }[],
  orderCreatedAtIso: string,
): string | null {
  const t = Date.parse(orderCreatedAtIso);
  if (!Number.isFinite(t)) return null;
  const ids = new Set(
    claims
      .filter((c) => Math.abs(Date.parse(c.claimed_at) - t) <= RENEWAL_CLAIM_WINDOW_MS)
      .map((c) => c.subscription_id),
  );
  return ids.size === 1 ? [...ids][0] : null;
}
