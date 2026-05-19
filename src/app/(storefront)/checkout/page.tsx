/**
 * Checkout — step 5 of the post-Shopify funnel.
 *
 *   PDP → Customize → /checkout?token=... → Thank You
 *
 * Server shell loads the cart_draft + workspace branding and hands
 * everything to the client island. The actual payment UI is Braintree's
 * Drop-in, mounted in CheckoutClient.
 *
 * If the cart isn't in `open` status (already converted, abandoned)
 * we send the customer back to the store root.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { CheckoutClient } from "./_components/CheckoutClient";
import type { CartDraft } from "../customize/_components/CustomizeClient";

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

export const dynamic = "force-dynamic";

export default async function CheckoutPage({ searchParams }: PageProps) {
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
  if (cart.status !== "open") {
    // Already converted → bounce to thank-you for the resulting order.
    if (cart.status === "converted" && cart.converted_order_id) {
      redirect(`/thank-you?order=${cart.converted_order_id}`);
    }
    redirect("/");
  }

  const { data: workspace } = await admin
    .from("workspaces")
    .select(
      "id, name, storefront_slug, storefront_primary_color, storefront_logo_url, storefront_domain",
    )
    .eq("id", cart.workspace_id)
    .single();

  return (
    <main className="min-h-screen bg-zinc-50">
      <CheckoutClient
        cart={cart as CartDraft}
        workspace={{
          id: workspace?.id || cart.workspace_id,
          name: workspace?.name || "Store",
          logo_url: workspace?.storefront_logo_url || null,
          primary_color: workspace?.storefront_primary_color || "#18181b",
          storefront_domain: workspace?.storefront_domain || null,
        }}
        sourceProductHandle={(cart as { source_product_handle?: string | null }).source_product_handle || null}
      />
    </main>
  );
}
