/**
 * Helpers for appending cart items to an existing internal
 * subscription. Used by the three-way checkout choice:
 *
 *   "add_to_sub"   → subscribe-mode cart items become RECURRING
 *                    items on the sub (every renewal); one-time
 *                    cart items (gifts) become ONE-TIME items
 *                    (ride next renewal then drop off).
 *   "renewal_only" → ALL cart items become ONE-TIME items on the
 *                    sub. No charge today, no separate order.
 *
 * One-time items live on `subscriptions.items[]` with
 * `one_time_next_renewal: true`. The renewal billing-tick reads
 * them like normal items, charges accordingly, then on successful
 * order creation removes them from the array.
 *
 * Always bumps the sub's `updated_at` so the portal's tax quote
 * invalidates and re-quotes on next load.
 */
import { createAdminClient } from "@/lib/supabase/admin";

interface CartItemLike {
  variant_id: string;
  product_id: string;
  shopify_variant_id: string | null;
  sku?: string | null;
  title: string;
  variant_title: string | null;
  image_url: string | null;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
  mode?: "subscribe" | "onetime";
  is_gift?: boolean;
}

interface SubItemRecord {
  variant_id?: string;
  product_id?: string;
  shopify_variant_id?: string | null;
  sku?: string | null;
  title?: string;
  variant_title?: string | null;
  image_url?: string | null;
  quantity: number;
  price_cents: number;
  is_gift?: boolean;
  one_time_next_renewal?: boolean;
}

export type SubAddMode = "add_to_sub" | "renewal_only";

/**
 * Validate the sub belongs to the customer and is internal+active.
 * Returns the sub row on success, null on any failure.
 */
export async function loadAndValidateSub(
  workspaceId: string,
  subId: string,
  customerId: string,
): Promise<{ id: string; items: SubItemRecord[] } | null> {
  const admin = createAdminClient();
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, customer_id, workspace_id, items, is_internal, status")
    .eq("id", subId)
    .maybeSingle();
  if (!sub) return null;
  if (sub.workspace_id !== workspaceId) return null;
  if (sub.customer_id !== customerId) return null;
  if (!sub.is_internal) return null;
  if (sub.status !== "active") return null;
  return { id: sub.id, items: (sub.items as SubItemRecord[]) || [] };
}

/**
 * Build the items to append. For add_to_sub: subscribe-mode lines
 * become recurring, gift/one-time lines become one_time_next_renewal.
 * For renewal_only: everything becomes one_time_next_renewal.
 */
function buildAppendItems(cartLines: CartItemLike[], mode: SubAddMode): SubItemRecord[] {
  return cartLines.map((l) => {
    const oneTime = mode === "renewal_only"
      || (mode === "add_to_sub" && (l.is_gift || l.mode !== "subscribe"));
    return {
      variant_id: l.variant_id,
      product_id: l.product_id,
      shopify_variant_id: l.shopify_variant_id,
      sku: l.sku || null,
      title: l.title,
      variant_title: l.variant_title,
      image_url: l.image_url,
      quantity: l.quantity,
      // Store the cart price for what the customer saw. Renewal flow
      // can recompute against the sub's pricing rules later (TODO).
      price_cents: l.unit_price_cents,
      is_gift: !!l.is_gift,
      one_time_next_renewal: oneTime,
    };
  });
}

/**
 * Merge new items into a sub's existing items array.
 *
 * Recurring items (matching variant_id, both recurring) merge by
 * summing quantities — adding the same Coffee twice via this path
 * bumps the existing line's quantity instead of duplicating it.
 *
 * One-time items always append as new rows (so the upcoming
 * "free gift" line can sit alongside an existing recurring Coffee
 * for the same variant).
 */
function mergeItems(existing: SubItemRecord[], additions: SubItemRecord[]): SubItemRecord[] {
  const out = [...existing];
  for (const add of additions) {
    if (add.one_time_next_renewal) {
      out.push(add);
      continue;
    }
    const idx = out.findIndex((e) =>
      !e.one_time_next_renewal && !e.is_gift && e.variant_id === add.variant_id,
    );
    if (idx >= 0) {
      out[idx] = { ...out[idx], quantity: (out[idx].quantity || 0) + add.quantity };
    } else {
      out.push(add);
    }
  }
  return out;
}

export async function appendCartItemsToSub(
  workspaceId: string,
  subId: string,
  customerId: string,
  cartLines: CartItemLike[],
  mode: SubAddMode,
): Promise<{ success: boolean; error?: string; merged_items?: SubItemRecord[] }> {
  const sub = await loadAndValidateSub(workspaceId, subId, customerId);
  if (!sub) return { success: false, error: "sub_not_found_or_unauthorized" };

  const additions = buildAppendItems(cartLines, mode);
  if (additions.length === 0) return { success: true, merged_items: sub.items };

  const merged = mergeItems(sub.items, additions);
  const admin = createAdminClient();
  const { error } = await admin
    .from("subscriptions")
    .update({ items: merged, updated_at: new Date().toISOString() })
    .eq("id", subId);
  if (error) return { success: false, error: error.message };
  return { success: true, merged_items: merged };
}
