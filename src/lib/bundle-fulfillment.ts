/**
 * Bundle fulfillment remap.
 *
 * A "bundle" product (e.g. the Amazing Coffee **Starter Kit**) sells through a
 * marker variant — `products.bundle_variant_id` (SKU `SF-STARTER-KIT`) — that
 * anchors the bundle OFFER (its free-gift `included` items) and the bundle
 * coupon. That marker variant is NOT stocked at the 3PL: Amplifier rejects it as
 * an "Unknown SKU", so a first order whose paid line is the marker fails to
 * import and never ships (bug behind SHOPCX74).
 *
 * The marker must stay on the CART line so the offer keeps firing + re-attaching
 * (offers are keyed on the paid anchor variant, and `ensureCartAttachments`
 * re-derives on every cart mutation). So we remap at CHECKOUT — when the order's
 * (and subscription's) line items are written — DOWNSTREAM of offer attachment:
 * the paid marker line is swapped to the product's BASE variant (its
 * lowest-position real, fulfillable variant — Cocoa French Roast for Amazing
 * Coffee). Gift / offer-sourced lines are never touched. The quoted price is
 * preserved; only which SKU fulfills changes. (CEO 2026-07-23: Starter Kit always
 * fulfills as the default coffee.)
 */
import { createAdminClient } from "@/lib/supabase/admin";

export interface RemappableLine {
  variant_id: string;
  product_id?: string;
  sku?: string | null;
  title?: string;
  variant_title?: string | null;
  image_url?: string | null;
  is_gift?: boolean;
  offer_source_variant_id?: string;
}

export interface BaseVariantTarget {
  id: string;
  product_id: string;
  sku: string | null;
  /** The base variant's own title (e.g. "Cocoa French Roast"). */
  variant_title: string | null;
  image_url: string | null;
}

/**
 * Pure core: given a `bundleVariantId → base variant` map, swap each PAID line
 * (never a gift or offer-sourced line) whose variant is a bundle marker to that
 * bundle's base variant. Preserves the line's price and quantity — only the
 * fulfillable identity (variant_id / sku / variant_title) changes. Split out so
 * it's unit-testable without Supabase.
 */
export function remapBundleLinesToBase<T extends RemappableLine>(
  lines: T[],
  bundleToBase: Map<string, BaseVariantTarget>,
): T[] {
  if (bundleToBase.size === 0) return lines;
  return lines.map((l) => {
    if (l.is_gift || l.offer_source_variant_id) return l; // never remap gift / offer lines
    const base = bundleToBase.get(l.variant_id);
    if (!base) return l;
    return {
      ...l,
      variant_id: base.id,
      product_id: base.product_id,
      sku: base.sku,
      variant_title: base.variant_title,
      image_url: l.image_url ?? base.image_url,
    };
  });
}

/**
 * Remap any paid bundle-marker line in `lines` to its product's base variant.
 * A line is a bundle marker when its `variant_id` equals some
 * `products.bundle_variant_id`; the base variant is that product's
 * lowest-position variant that is NOT the marker itself. No-op (returns the
 * input) when the cart contains no bundle-marker lines.
 */
export async function resolveBundleFulfillmentLines<T extends RemappableLine>(
  workspaceId: string,
  lines: T[],
): Promise<T[]> {
  const paidVariantIds = Array.from(
    new Set(
      lines
        .filter((l) => !l.is_gift && !l.offer_source_variant_id && l.variant_id)
        .map((l) => l.variant_id),
    ),
  );
  if (paidVariantIds.length === 0) return lines;

  const admin = createAdminClient();
  const { data: products } = await admin
    .from("products")
    .select("id, bundle_variant_id")
    .eq("workspace_id", workspaceId)
    .in("bundle_variant_id", paidVariantIds);
  if (!products || products.length === 0) return lines;

  const bundleToBase = new Map<string, BaseVariantTarget>();
  for (const p of products) {
    const { data: base } = await admin
      .from("product_variants")
      .select("id, product_id, sku, title, image_url")
      .eq("workspace_id", workspaceId)
      .eq("product_id", p.id)
      .neq("id", p.bundle_variant_id as string)
      .order("position", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (base) {
      bundleToBase.set(String(p.bundle_variant_id), {
        id: String(base.id),
        product_id: String(base.product_id),
        sku: (base.sku as string | null) ?? null,
        variant_title: (base.title as string | null) ?? null,
        image_url: (base.image_url as string | null) ?? null,
      });
    }
  }
  return remapBundleLinesToBase(lines, bundleToBase);
}
