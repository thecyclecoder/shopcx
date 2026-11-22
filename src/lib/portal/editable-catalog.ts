/**
 * Shared editable catalog — the ONE place that decides which products/variants a
 * customer may swap or add INTO on a subscription, for BOTH the Portal and the
 * next-order journey (mini-site).
 *
 * CEO rule (2026-11-22): cancels, saves and account management exist on the Portal
 * AND in journeys and must stay in sync. The journey used to load every `products`
 * row (including Shipping Protection, out-of-stock and suppressed variants) while
 * the Portal applied a stack of filters in its bootstrap handler — the two surfaces
 * had diverged. This module extracts that logic so both call the same helper.
 *
 * The swap/add rule (`isSwappableConsumable`):
 *   - Must be IN STOCK by the canonical storefront on-hand ([[inventory/read]]
 *     `getShopifyOnHandByVariant`) — NOT the retired `inventory_quantity` scalar,
 *     which is always NULL now (docs/brain/tables/product_variants.md). The Portal's
 *     old `inventory_quantity == null || > 0` filter therefore passed EVERYTHING,
 *     which is exactly how out-of-stock variants (Strawberry Lemonade Tabs,
 *     Cocoa Instant Coffee) leaked into the swap list.
 *   - Never Shipping Protection (`product_type='ShopWill'` / handle
 *     `shipping-insurance`), surfaced AND excluded by configured id in
 *     `loadEditableCatalog` so a title-keyword miss can't let it through.
 *   - Never a `(Free Gift)` duplicate (the three ids in `SHOPIFY_PRODUCT_ALIASES`),
 *     the internal `Mystery Item`, or a digital good.
 *   - Never a suppressed-for-new-choice variant ([[mutation-guard]]
 *     `getSuppressedVariantIds`).
 *
 * The rule is enforced server-side on swap/add in both surfaces via
 * `assertSwappableConsumable`, not only hidden in the UI.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getSuppressedVariantIds } from "@/lib/portal/mutation-guard";
import { getShopifyOnHandByVariant } from "@/lib/inventory/read";
import { SHOPIFY_PRODUCT_ALIASES } from "@/lib/shopify-review-metafields";

type Admin = ReturnType<typeof createAdminClient>;

/** The product-level fields the swap/add rule looks at. */
export interface CatalogProductInfo {
  /** Shopify product id (string). Used for the free-gift-duplicate alias check. */
  productId: string | null;
  title: string;
  handle: string | null;
  productType: string | null;
}

/** The variant-level fields the swap/add rule looks at. */
export interface CatalogVariantInfo {
  /** Shopify variant id (string). */
  variantId: string;
  title: string | null;
  priceCents: number | null;
  /** Canonical storefront on-hand (0 when unknown — treated as out of stock). */
  onHand: number;
}

export interface EditableCatalogVariant extends CatalogVariantInfo {
  /** The raw JSONB variant object, preserved so the Portal client keeps its shape. */
  raw: Record<string, unknown>;
}

export interface EditableCatalogProduct extends CatalogProductInfo {
  /** Internal products.id (UUID). */
  internalId: string;
  imageUrl: string | null;
  rating: number;
  ratingCount: number;
  variants: EditableCatalogVariant[];
}

export interface EditableCatalog {
  products: EditableCatalogProduct[];
  /** Configured Shipping Protection Shopify PRODUCT ids (never offered as a product). */
  shippingProtectionProductIds: string[];
  /** Resolved Shipping Protection variant ids (first variant per SP product). */
  shippingProtectionVariantIds: string[];
}

/** Strip a `gid://shopify/ProductVariant/123` prefix down to `123`. */
function stripGid(v: unknown): string {
  const s = String(v ?? "").trim();
  return s.includes("/") ? (s.split("/").pop() || s) : s;
}

const SHIPPING_PROTECTION_KEYWORDS = ["shipping protection", "shipping insurance", "insure", "route protection"];

function titleIsShippingProtection(title: string): boolean {
  const t = (title || "").toLowerCase();
  return SHIPPING_PROTECTION_KEYWORDS.some((kw) => t.includes(kw));
}

const FREE_GIFT_PRODUCT_IDS = new Set(Object.keys(SHOPIFY_PRODUCT_ALIASES));

/**
 * Pure predicate — may a customer swap or add INTO this (product, variant)?
 *
 * CEO rule (2026-11-22): only a consumable product that is in stock. Never Shipping
 * Protection, a free-gift duplicate, the internal Mystery Item, a digital good, or
 * an out-of-stock variant. Pure (no I/O) so the failing state ("Cocoa Instant Coffee
 * with on-hand 0 is rejected") is unit-testable without touching Supabase.
 */
export function isSwappableConsumable(
  product: CatalogProductInfo,
  variant: CatalogVariantInfo,
): boolean {
  // Must be genuinely in stock by canonical storefront on-hand. A missing/zero
  // figure is OUT of stock — the opposite of the old null-means-available filter.
  if (!(variant.onHand > 0)) return false;

  const type = (product.productType || "").toLowerCase();
  const handle = (product.handle || "").toLowerCase();
  const title = (product.title || "").toLowerCase();

  // Shipping Protection — by product_type / handle / title.
  if (type === "shopwill") return false;
  if (handle === "shipping-insurance") return false;
  if (titleIsShippingProtection(product.title)) return false;

  // Free-gift duplicate listings (separate Shopify products for the same item).
  if (product.productId && FREE_GIFT_PRODUCT_IDS.has(String(product.productId))) return false;
  if (title.includes("(free gift)") || title.includes("free gift")) return false;

  // Internal Mystery Item SKU — never customer-selectable.
  if (title === "mystery item" || title.includes("mystery item")) return false;

  // Digital goods — not a physical consumable.
  if (type === "digital" || type === "digital_product" || handle === "gift-card" || title.includes("gift card")) {
    return false;
  }

  return true;
}

/**
 * Load the catalog of products/variants a customer may swap or add INTO, applying the
 * SAME filters on the Portal and the journey: limited to the configured
 * `products_available_to_add`, Shipping Protection excluded by configured id,
 * suppressed variants dropped, and every remaining (product, variant) passed through
 * `isSwappableConsumable` (in-stock + consumable). The single source of truth for the
 * swap/add list on both surfaces.
 */
export async function loadEditableCatalog(
  workspaceId: string,
  admin: Admin = createAdminClient(),
): Promise<EditableCatalog> {
  const { data: ws } = await admin
    .from("workspaces")
    .select("portal_config")
    .eq("id", workspaceId)
    .maybeSingle();

  const portalConfig = (ws?.portal_config || {}) as Record<string, unknown>;
  const general = (portalConfig.general || {}) as Record<string, unknown>;
  const productIds = Array.isArray(general.products_available_to_add)
    ? general.products_available_to_add.filter(Boolean).map((x) => String(x))
    : [];
  const spProductIds = Array.isArray(general.shipping_protection_product_ids)
    ? general.shipping_protection_product_ids.filter(Boolean).map((x) => String(x))
    : [];
  const spProductIdSet = new Set(spProductIds);

  if (!productIds.length) {
    return { products: [], shippingProtectionProductIds: spProductIds, shippingProtectionVariantIds: [] };
  }

  const [{ data: products }, suppressed, onHand] = await Promise.all([
    admin
      .from("products")
      .select("id, shopify_product_id, title, handle, product_type, image_url, variants, rating, rating_count")
      .eq("workspace_id", workspaceId)
      .in("shopify_product_id", productIds),
    getSuppressedVariantIds(workspaceId),
    getShopifyOnHandByVariant(admin, workspaceId),
  ]);

  const out: EditableCatalogProduct[] = [];
  for (const p of products || []) {
    const shopifyProductId = p.shopify_product_id != null ? String(p.shopify_product_id) : null;
    // Shipping Protection is never offered as a product — excluded by CONFIGURED id
    // (not only the title keyword), per the CEO rule.
    if (shopifyProductId && spProductIdSet.has(shopifyProductId)) continue;

    const productInfo: CatalogProductInfo = {
      productId: shopifyProductId,
      title: p.title || "",
      handle: p.handle ?? null,
      productType: p.product_type ?? null,
    };

    const rawVariants = (Array.isArray(p.variants) ? p.variants : []) as Record<string, unknown>[];
    const variants: EditableCatalogVariant[] = [];
    for (const v of rawVariants) {
      const variantId = stripGid(v.id);
      if (!variantId) continue;
      if (suppressed.has(variantId)) continue;
      const priceCents = typeof v.price_cents === "number" ? (v.price_cents as number) : null;
      const variantInfo: CatalogVariantInfo = {
        variantId,
        title: (v.title as string) ?? null,
        priceCents,
        onHand: onHand.get(variantId) ?? 0,
      };
      if (!isSwappableConsumable(productInfo, variantInfo)) continue;
      variants.push({ ...variantInfo, raw: v });
    }
    if (!variants.length) continue;

    out.push({
      ...productInfo,
      internalId: p.id,
      imageUrl: p.image_url ?? null,
      rating: p.rating || 0,
      ratingCount: p.rating_count || 0,
      variants,
    });
  }

  // Resolve SP variant ids (first variant per configured SP product) — the Portal
  // returns these to the client so the shipping-protection toggle keeps working.
  const spVariantIds: string[] = [];
  if (spProductIds.length) {
    const { data: spProducts } = await admin
      .from("products")
      .select("shopify_product_id, variants")
      .eq("workspace_id", workspaceId)
      .in("shopify_product_id", spProductIds);
    for (const p of spProducts || []) {
      const rawVariants = (Array.isArray(p.variants) ? p.variants : []) as Record<string, unknown>[];
      for (const v of rawVariants) {
        const id = stripGid(v.id);
        if (id) {
          spVariantIds.push(id);
          break; // one variant per product
        }
      }
    }
  }

  return { products: out, shippingProtectionProductIds: spProductIds, shippingProtectionVariantIds: spVariantIds };
}

/** Resolved (product, variant) context for a set of target variant ids. */
export interface VariantSwapContext {
  product: CatalogProductInfo;
  variant: CatalogVariantInfo;
}

/**
 * Resolve each target variant id → its product + canonical on-hand context, so a caller
 * can apply `isSwappableConsumable` directly. The `products.variants` JSONB mirror is the
 * shape both surfaces read; product context comes from it and on-hand from canonical
 * inventory. A variant not present in the catalog has no entry (caller treats absent as
 * "can't prove swappable" → block).
 */
export async function resolveVariantSwapContexts(
  workspaceId: string,
  variantIds: Array<string | number>,
  admin: Admin = createAdminClient(),
): Promise<Map<string, VariantSwapContext>> {
  const out = new Map<string, VariantSwapContext>();
  const ids = variantIds.map((v) => stripGid(v)).filter(Boolean);
  if (!ids.length) return out;
  const wanted = new Set(ids);

  const onHand = await getShopifyOnHandByVariant(admin, workspaceId);
  const { data: products } = await admin
    .from("products")
    .select("shopify_product_id, title, handle, product_type, variants")
    .eq("workspace_id", workspaceId);

  for (const p of products || []) {
    const productInfo: CatalogProductInfo = {
      productId: p.shopify_product_id != null ? String(p.shopify_product_id) : null,
      title: p.title || "",
      handle: p.handle ?? null,
      productType: p.product_type ?? null,
    };
    const rawVariants = (Array.isArray(p.variants) ? p.variants : []) as Record<string, unknown>[];
    for (const v of rawVariants) {
      const variantId = stripGid(v.id);
      if (!variantId || !wanted.has(variantId)) continue;
      out.set(variantId, {
        product: productInfo,
        variant: {
          variantId,
          title: (v.title as string) ?? null,
          priceCents: typeof v.price_cents === "number" ? (v.price_cents as number) : null,
          onHand: onHand.get(variantId) ?? 0,
        },
      });
    }
  }
  return out;
}

/**
 * Server-side enforcement of the swap/add rule for a set of NEW target variant ids,
 * on BOTH surfaces. Resolves each variant → its product + canonical on-hand and
 * applies `isSwappableConsumable`, so a crafted request naming an out-of-stock /
 * Shipping-Protection / free-gift / mystery / digital variant is rejected no matter
 * what the UI showed. Returns `{ ok: true }` when nothing is blocked (including the
 * empty-input fast path), else `{ ok: false, blocked }` naming the offending ids.
 */
export async function assertSwappableConsumable(
  workspaceId: string,
  variantIds: Array<string | number>,
  admin: Admin = createAdminClient(),
): Promise<{ ok: true } | { ok: false; blocked: string[] }> {
  const ids = variantIds.map((v) => stripGid(v)).filter(Boolean);
  if (!ids.length) return { ok: true };

  const contexts = await resolveVariantSwapContexts(workspaceId, ids, admin);
  const blocked: string[] = [];
  for (const id of ids) {
    const hit = contexts.get(id);
    // An unknown variant (not in the catalog) can't be proven swappable → block.
    if (!hit || !isSwappableConsumable(hit.product, hit.variant)) blocked.push(id);
  }
  return blocked.length ? { ok: false, blocked } : { ok: true };
}
