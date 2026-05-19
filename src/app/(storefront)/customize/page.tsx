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
import { createAdminClient } from "@/lib/supabase/admin";
import { CustomizeClient } from "./_components/CustomizeClient";
import type {
  CartDraft,
  ProductCatalogEntry,
  UpsellCandidate,
} from "./_components/CustomizeClient";

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

export const dynamic = "force-dynamic";

export default async function CustomizePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const cookieToken = (await cookies()).get("cart")?.value;
  const token = params.token || cookieToken;
  if (!token) redirect("/");

  const admin = createAdminClient();
  const { data: cart } = await admin
    .from("cart_drafts")
    .select("*")
    .eq("token", token)
    .eq("status", "open")
    .maybeSingle();

  if (!cart) redirect("/");

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

      let pricingRule:
        | { subscribe_discount_pct: number; available_frequencies: Array<{ interval_days: number; label: string; default?: boolean }> }
        | null = null;
      if (ruleAssignRes.data?.pricing_rule_id) {
        const { data: rule } = await admin
          .from("pricing_rules")
          .select("subscribe_discount_pct, available_frequencies")
          .eq("id", ruleAssignRes.data.pricing_rule_id)
          .maybeSingle();
        if (rule) {
          pricingRule = {
            subscribe_discount_pct: rule.subscribe_discount_pct || 0,
            available_frequencies: (rule.available_frequencies as ProductCatalogEntry["pricing_rule"] extends infer T ? T extends { available_frequencies: infer F } ? F : never : never) || [],
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
          .filter((p): p is NonNullable<typeof p> => p !== null)
          .filter((p) => p.product_id !== pid);

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
      />
    </main>
  );
}
