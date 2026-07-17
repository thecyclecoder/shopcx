/**
 * Customization page — step 4 of the post-Shopify funnel.
 *
 *   PDP → Select a pack/bundle → /customize?token=... → Checkout
 *
 * This page is a *worksheet*, not a cart view. For every product the
 * customer added, we render their full set of levers (variant pickers,
 * quantity, format swap to linked products, subscribe/onetime per item)
 * so they can finalize their order in one place. Server-side we fetch
 * the entire catalog slice they need to make those decisions without
 * any client round-trips — variants, pricing rules, linked-product
 * groups.
 *
 * Token resolution: ?token=... query param wins (lets us email
 * resume-cart links), otherwise we read the `cart` cookie set by
 * /api/cart. If neither is present we send the customer back to the
 * store root.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { findVariant } from "@/lib/product-variants";
import { CustomizeClient } from "./_components/CustomizeClient";
import type {
  CartDraft,
  ProductCatalogEntry,
  UpsellCandidate,
} from "./_components/CustomizeClient";
import type { Review } from "../_lib/page-data";
import { getStorefrontMetadata } from "../_lib/storefront-metadata";

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  await connection();
  // Inherit the originating workspace's favicon so the customer's
  // browser tab keeps the brand they started shopping on.
  const params = await searchParams;
  const cookieToken = (await cookies()).get("cart")?.value;
  const token = params.token || cookieToken;
  if (!token) return {};
  const admin = createAdminClient();
  const { data: cart } = await admin
    .from("cart_drafts")
    .select("workspace_id")
    .eq("token", token)
    .maybeSingle();
  if (!cart?.workspace_id) return {};
  return getStorefrontMetadata(cart.workspace_id as string, "Customize Your Order");
}

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}


export default async function CustomizePage({ searchParams }: PageProps) {
  await connection();
  const params = await searchParams;
  const cookieToken = (await cookies()).get("cart")?.value;
  const token = params.token || cookieToken;
  if (!token) redirect("/");

  const admin = createAdminClient();
  const { data: cart } = await admin
    .from("cart_drafts")
    .select("*")
    .eq("token", token)
    .maybeSingle();

  if (!cart) redirect("/");
  // A consumed cart (e.g. back-button after an order) isn't editable. Don't dump
  // the customer at "/" (which 404s → /login on the storefront domain): send a
  // converted cart to its order confirmation, otherwise back to the PDP.
  if (cart.status !== "open") {
    if (cart.status === "converted" && cart.converted_order_id) {
      redirect(`/thank-you?order=${cart.converted_order_id}`);
    }
    redirect(cart.source_product_handle ? `/${cart.source_product_handle}` : "/");
  }

  // ── Heal stale carts on load ───────────────────────────────────
  // Re-run ensureCartAttachments (strips paid lines for gift-target
  // products, re-derives offer-attached items + free-gift lines from
  // current offers + rules) and recompute totals. Idempotent: if
  // nothing changes, we skip the write. Covers carts created before
  // an offer / rule landed and any future drift.
  {
    const { ensureCartAttachments } = await import("@/lib/cart-gifts");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentLines = (cart.line_items as any[]) || [];
    const fixedLines = await ensureCartAttachments(cart.workspace_id as string, currentLines);
    const fixedSubtotal = fixedLines.reduce((s, l) => s + (l.line_total_cents || 0), 0);
    // Preserve the auto-applied coupon: keep the same effective discount RATE
    // when the subtotal shifts (the percentage coupon should track the new
    // subtotal, not vanish). /api/cart re-resolves authoritatively on edits.
    const priorDiscountRatio = cart.subtotal_cents > 0 ? (cart.discount_cents || 0) / cart.subtotal_cents : 0;
    const fixedDiscount = Math.round(fixedSubtotal * priorDiscountRatio);
    const fixedTotal = fixedSubtotal - fixedDiscount; // shipping/tax computed at checkout
    const linesChanged = JSON.stringify(fixedLines) !== JSON.stringify(currentLines);
    const totalsChanged = cart.subtotal_cents !== fixedSubtotal || cart.total_cents !== fixedTotal || cart.discount_cents !== fixedDiscount;
    if (linesChanged || totalsChanged) {
      await admin
        .from("cart_drafts")
        .update({
          line_items: fixedLines,
          subtotal_cents: fixedSubtotal,
          discount_cents: fixedDiscount,
          total_cents: fixedTotal,
          updated_at: new Date().toISOString(),
        })
        .eq("token", token);
      // Reflect the heal in the cart we pass downstream
      cart.line_items = fixedLines;
      cart.subtotal_cents = fixedSubtotal;
      cart.discount_cents = fixedDiscount;
      cart.total_cents = fixedTotal;
    }
  }

  // ── Per-product catalog ────────────────────────────────────────────
  // For every product the customer has in their cart, gather everything
  // they might want to swap to: all variants of that product, its
  // pricing rule (for sub discount + available frequencies), and any
  // linked products in its product_link_groups (e.g. Instant ↔ K-Cups).
  type LineItem = { product_id: string; variant_id: string; quantity: number };
  const lines = (cart.line_items as LineItem[]) || [];
  const productIds = [...new Set(lines.map((l) => l.product_id))];

  const productCatalog: Record<string, ProductCatalogEntry> = {};
  await Promise.all(
    productIds.map(async (pid) => {
      const [variantsRes, productRes, ruleAssignRes, linkMemberRes] = await Promise.all([
        admin
          .from("product_variants")
          .select("id, shopify_variant_id, title, image_url, price_cents, position")
          .eq("product_id", pid)
          .order("position", { ascending: true }),
        admin
          .from("products")
          .select("id, handle, title, image_url")
          .eq("id", pid)
          .single(),
        admin
          .from("product_pricing_rule")
          .select("pricing_rule_id")
          .eq("workspace_id", cart.workspace_id)
          .eq("product_id", pid)
          .maybeSingle(),
        admin
          .from("product_link_members")
          .select("group_id, value")
          .eq("product_id", pid)
          .maybeSingle(),
      ]);

      let pricingRule: ProductCatalogEntry["pricing_rule"] = null;
      if (ruleAssignRes.data?.pricing_rule_id) {
        const { data: rule } = await admin
          .from("pricing_rules")
          .select(
            "subscribe_discount_pct, available_frequencies, quantity_breaks, free_gift_variant_id, free_gift_product_title, free_gift_image_url, free_gift_min_quantity, free_gift_subscription_only",
          )
          .eq("id", ruleAssignRes.data.pricing_rule_id)
          .maybeSingle();
        if (rule) {
          // Resolve free-gift variant's perceived value ("$X.XX value")
          // by joining product_variants on the free_gift_variant_id.
          // The pricing-rules column holds the INTERNAL variant UUID
          // (matches `product_variants.id`), not the Shopify numeric id.
          let freeGiftPriceCents: number | null = null;
          let freeGiftProductId: string | null = null;
          if (rule.free_gift_variant_id) {
            // free_gift_variant_id is TEXT (UUID or Shopify numeric); findVariant
            // resolves by shape so a numeric id doesn't 22P02 on product_variants.id.
            const giftVariant = await findVariant(cart.workspace_id, {
              id: rule.free_gift_variant_id,
              shopifyVariantId: rule.free_gift_variant_id,
            });
            if (giftVariant) {
              freeGiftPriceCents = Math.max(
                giftVariant.compare_at_price_cents || 0,
                giftVariant.price_cents || 0,
              );
              freeGiftProductId = giftVariant.product_id || null;
            }
          }
          pricingRule = {
            subscribe_discount_pct: rule.subscribe_discount_pct || 0,
            available_frequencies: (rule.available_frequencies as ProductCatalogEntry["pricing_rule"] extends infer T ? T extends { available_frequencies: infer F } ? F : never : never) || [],
            quantity_breaks: (rule.quantity_breaks as Array<{ quantity: number; discount_pct: number; label: string }>) || [],
            free_gift_variant_id: rule.free_gift_variant_id || null,
            free_gift_product_id: freeGiftProductId,
            free_gift_product_title: rule.free_gift_product_title || null,
            free_gift_image_url: rule.free_gift_image_url || null,
            free_gift_min_quantity: rule.free_gift_min_quantity ?? 1,
            free_gift_subscription_only: rule.free_gift_subscription_only ?? false,
            free_gift_price_cents: freeGiftPriceCents,
          };
        }
      }

      // Linked products — peers in the same product_link_group, minus
      // this product itself. Each peer surfaces as a chip on the
      // worksheet (e.g. swap Instant ↔ K-Cups).
      let linkedProducts: ProductCatalogEntry["linked_products"] = [];
      if (linkMemberRes.data?.group_id) {
        const groupId = linkMemberRes.data.group_id;
        const { data: groupHeader } = await admin
          .from("product_link_groups")
          .select("name")
          .eq("id", groupId)
          .maybeSingle();
        const { data: peers } = await admin
          .from("product_link_members")
          .select("product_id, value, display_order, products!inner(id, handle, title, image_url, status)")
          .eq("group_id", groupId)
          .order("display_order", { ascending: true });
        const peerRows = ((peers || []) as Array<{
          product_id: string;
          value: string;
          display_order: number;
          products: { id: string; handle: string; title: string; image_url: string | null; status: string } | { id: string; handle: string; title: string; image_url: string | null; status: string }[] | null;
        }>)
          .map((p) => {
            // Supabase resolves !inner to an object, but typescript types
            // it as object|array — normalize.
            const prod = Array.isArray(p.products) ? p.products[0] : p.products;
            return prod && prod.status === "active"
              ? {
                  product_id: prod.id,
                  handle: prod.handle,
                  title: prod.title,
                  image_url: prod.image_url,
                  value: p.value,
                  display_order: p.display_order,
                }
              : null;
          })
          .filter((p): p is NonNullable<typeof p> => p !== null);
        // Keep the CURRENT product in linked_products so the
        // worksheet can look up its `value` (e.g. "Instant") for the
        // selected chip's label. The render filters peers on the
        // client side when listing the other chips.

        // Hydrate each peer with its variants so the worksheet can swap
        // inline (no PDP round-trip). Variant-title matching lets us
        // preserve flavor across the swap (Hazelnut Instant → Hazelnut
        // K-Cups when both products have a Hazelnut variant).
        linkedProducts = await Promise.all(
          peerRows.map(async (peer) => {
            const { data: peerVariants } = await admin
              .from("product_variants")
              .select("id, shopify_variant_id, title, image_url, price_cents, position")
              .eq("product_id", peer.product_id)
              .order("position", { ascending: true });
            return {
              ...peer,
              variants: (peerVariants || []).map((v) => ({
                id: v.id,
                shopify_variant_id: v.shopify_variant_id,
                title: v.title,
                image_url: v.image_url,
                price_cents: v.price_cents,
                position: v.position,
              })),
            };
          }),
        );
        // Stash group label on the entry for the chip section title
        if (groupHeader?.name) {
          (linkedProducts as unknown as { group_name?: string }).group_name = groupHeader.name;
        }
      }

      productCatalog[pid] = {
        product: {
          id: productRes.data?.id || pid,
          handle: productRes.data?.handle || "",
          title: productRes.data?.title || "Item",
          image_url: productRes.data?.image_url || null,
        },
        variants: (variantsRes.data || []).map((v) => ({
          id: v.id,
          shopify_variant_id: v.shopify_variant_id,
          title: v.title,
          image_url: v.image_url,
          price_cents: v.price_cents,
          position: v.position,
        })),
        pricing_rule: pricingRule,
        linked_products: linkedProducts,
        linked_group_name: linkMemberRes.data?.group_id
          ? ((linkedProducts as unknown as { group_name?: string }).group_name || null)
          : null,
      };
    }),
  );

  // ── Upsells — bestsellers not already in the cart ──────────────────
  // (kept as-is for now; the worksheet renders these in their own
  // section. We'll refine when we tackle the upsell edits.)
  const cartProductIds = new Set(lines.map((l) => l.product_id));
  const { data: candidates } = await admin
    .from("products")
    .select("id, handle, title, image_url")
    .eq("workspace_id", cart.workspace_id)
    .eq("is_bestseller", true)
    .eq("status", "active")
    .limit(6);

  const upsells: UpsellCandidate[] = await Promise.all(
    ((candidates || []) as { id: string; handle: string; title: string; image_url: string | null }[])
      .filter((p) => !cartProductIds.has(p.id))
      .slice(0, 3)
      .map(async (p) => {
        const { data: variant } = await admin
          .from("product_variants")
          .select("id, shopify_variant_id, price_cents, image_url, title")
          .eq("product_id", p.id)
          .order("position", { ascending: true })
          .limit(1)
          .maybeSingle();
        return {
          product_id: p.id,
          handle: p.handle,
          title: p.title,
          image_url: variant?.image_url || p.image_url,
          variant_id: variant?.id || null,
          shopify_variant_id: variant?.shopify_variant_id || null,
          variant_title: variant?.title || null,
          price_cents: variant?.price_cents ?? 0,
        };
      }),
  );

  // Workspace branding + storefront domain (not Shopify — this is the
  // post-Shopify storefront, so we use storefront_domain end-to-end).
  const { data: workspace } = await admin
    .from("workspaces")
    .select(
      "id, name, storefront_slug, storefront_primary_color, storefront_logo_url, storefront_domain",
    )
    .eq("id", cart.workspace_id)
    .single();

  // Featured reviews — surface at the bottom of the worksheet to keep
  // purchase confidence high. Pulls the featured pool for every
  // product currently in the cart (plus any linked-group peers so
  // social proof for Instant carries to a K-Cups swap and back).
  const reviewProductIds = new Set<string>(productIds);
  for (const pid of productIds) {
    for (const peer of productCatalog[pid]?.linked_products || []) {
      reviewProductIds.add(peer.product_id);
    }
  }
  const { data: featuredReviewsRaw } = await admin
    .from("product_reviews")
    .select("id, reviewer_name, rating, title, body, images, smart_quote, created_at, status, featured, product_id")
    .eq("workspace_id", cart.workspace_id)
    .in("product_id", [...reviewProductIds])
    .in("status", ["published", "featured"])
    .not("body", "is", null)
    .order("featured", { ascending: false })
    .order("rating", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(24);
  const featuredReviews: Review[] = ((featuredReviewsRaw || []) as Review[]).filter(
    (r) => r.featured === true || r.status === "featured",
  );
  // Use the FIRST cart product's handle for the bootstrap-cache refresh
  // (the widget periodically pulls a fresh featured pool to avoid stale
  // ISR). Multi-product carts converge to the dominant product.
  const primaryProductHandle = productCatalog[productIds[0]]?.product.handle || null;

  return (
    <main className="min-h-screen bg-zinc-50">
      <CustomizeClient
        cart={cart as CartDraft}
        productCatalog={productCatalog}
        upsells={upsells}
        workspace={{
          id: workspace?.id || cart.workspace_id,
          name: workspace?.name || "Store",
          logo_url: workspace?.storefront_logo_url || null,
          primary_color: workspace?.storefront_primary_color || "#18181b",
          storefront_domain: workspace?.storefront_domain || null,
          storefront_slug: workspace?.storefront_slug || null,
        }}
        sourceProductHandle={(cart as { source_product_handle?: string | null }).source_product_handle || null}
        featuredReviews={featuredReviews}
        primaryProductHandle={primaryProductHandle}
      />
    </main>
  );
}
