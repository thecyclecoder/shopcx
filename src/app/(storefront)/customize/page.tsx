/**
 * Customization page — step 4 of the post-Shopify funnel.
 *
 *   PDP → Select a pack/bundle → /customize?token=... → Checkout
 *
 * Token resolution: ?token=... query param wins (lets us email
 * resume-cart links), otherwise we read the `cart` cookie set by
 * /api/cart. If neither is present we send the customer back to the
 * store root.
 *
 * Server-rendered shell + client island for upsell add + funnel
 * tracking. SSR keeps the page fast on first paint and avoids the
 * "flash of empty cart" you get from client-side fetches.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { CustomizeClient } from "./_components/CustomizeClient";
import type { CartDraft, UpsellCandidate } from "./_components/CustomizeClient";

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

  // Upsell candidates: bestseller products in the same workspace that
  // aren't already in the cart. Admins curate which products qualify
  // by toggling `is_bestseller` per product in the storefront
  // settings.
  const cartProductIds = new Set(
    ((cart.line_items as { product_id: string }[]) || []).map((l) => l.product_id),
  );
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
        // Pull the cheapest variant for a one-line "add one of these"
        // experience; we don't show variant pickers on this page.
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

  // Pull workspace branding so the customize page reads as the same
  // brand as the PDP that sent the customer here.
  const { data: workspace } = await admin
    .from("workspaces")
    .select(
      "id, name, storefront_slug, storefront_primary_color, storefront_logo_url, shopify_myshopify_domain",
    )
    .eq("id", cart.workspace_id)
    .single();

  return (
    <main className="min-h-screen bg-zinc-50">
      <CustomizeClient
        cart={cart as CartDraft}
        upsells={upsells}
        workspace={{
          id: workspace?.id || cart.workspace_id,
          name: workspace?.name || "Store",
          logo_url: workspace?.storefront_logo_url || null,
          primary_color: workspace?.storefront_primary_color || "#18181b",
          shopify_domain: workspace?.shopify_myshopify_domain || null,
        }}
      />
    </main>
  );
}
