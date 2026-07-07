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
import { connection } from "next/server";
import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { CheckoutClient } from "./_components/CheckoutClient";
import type { CartDraft } from "../customize/_components/CustomizeClient";
import { getStorefrontMetadata } from "../_lib/storefront-metadata";
import { ensureCartAttachments, type CartLineLike } from "@/lib/cart-gifts";

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  await connection();
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
  return getStorefrontMetadata(cart.workspace_id as string, "Secure Checkout");
}

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}


export default async function CheckoutPage({ searchParams }: PageProps) {
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
  if (cart.status !== "open") {
    // Already converted → bounce to thank-you for the resulting order.
    if (cart.status === "converted" && cart.converted_order_id) {
      redirect(`/thank-you?order=${cart.converted_order_id}`);
    }
    // Otherwise back to the PDP they came from — never "/" (404s → /login on
    // the storefront domain).
    redirect(cart.source_product_handle ? `/${cart.source_product_handle}` : "/");
  }

  // Backfill / heal offer-attached items + free gifts on every render.
  // ensureCartAttachments strips existing gift/offer lines and re-derives
  // them from the current offers + rules, so stale fields (image_url,
  // title) refresh automatically. We persist back to the cart so
  // subsequent loads + the eventual /api/checkout call see the healed
  // lines.
  const baseLines = (cart.line_items as CartLineLike[]) || [];
  const linesWithGifts = await ensureCartAttachments(cart.workspace_id as string, baseLines);
  if (JSON.stringify(baseLines) !== JSON.stringify(linesWithGifts)) {
    const newSubtotalCents = linesWithGifts.reduce((s, l) => s + l.line_total_cents, 0);
    // Preserve any persisted coupon discount — gifts are $0 lines so the
    // subtotal is unchanged, but total_cents must stay subtotal − discount or
    // the coupon silently vanishes on this checkout render.
    const newTotalCents = newSubtotalCents - ((cart.discount_cents as number) || 0);
    await admin
      .from("cart_drafts")
      .update({
        line_items: linesWithGifts,
        subtotal_cents: newSubtotalCents,
        total_cents: newTotalCents,
        updated_at: new Date().toISOString(),
      })
      .eq("token", token);
    cart.line_items = linesWithGifts;
    cart.subtotal_cents = newSubtotalCents;
    cart.total_cents = newTotalCents;
  }

  const { data: workspace } = await admin
    .from("workspaces")
    .select(
      "id, name, storefront_slug, storefront_primary_color, storefront_logo_url, storefront_domain, shipping_protection_enabled, shipping_protection_price_cents, shipping_protection_title, shipping_protection_description, storefront_skip_customize",
    )
    .eq("id", cart.workspace_id)
    .single();

  // Meta browser pixel id (public) so checkout fires InitiateCheckout
  // deduped with the server CAPI stream.
  const { getMetaPixelId } = await import("@/lib/meta-capi");
  const metaPixelId = await getMetaPixelId(cart.workspace_id as string);

  // If the customer already identified via /api/checkout/identify, pull
  // their first/last so the contact-card name fields re-hydrate after
  // refresh. Cart already carries email/phone; first/last live on the
  // customer record because they're not strictly cart properties.
  let initialFirstName = "";
  let initialLastName = "";
  if (cart.customer_id) {
    const { data: cust } = await admin
      .from("customers")
      .select("first_name, last_name")
      .eq("id", cart.customer_id)
      .maybeSingle();
    initialFirstName = (cust?.first_name as string) || "";
    initialLastName = (cust?.last_name as string) || "";
  }

  // Featured reviews for the right-sidebar widget (desktop) /
  // bottom-of-page widget (mobile). Same source we use on customize.
  const lineProductIds = ((cart.line_items as Array<{ product_id?: string }>) || [])
    .map((l) => l.product_id)
    .filter(Boolean);
  let featuredReviews: Array<Record<string, unknown>> = [];
  let primaryProductHandle: string | null = null;
  if (lineProductIds.length > 0) {
    const { data: reviewsRaw } = await admin
      .from("product_reviews")
      .select("id, reviewer_name, rating, title, body, images, smart_quote, created_at, status, featured, product_id")
      .eq("workspace_id", cart.workspace_id)
      .in("product_id", lineProductIds as string[])
      .in("status", ["published", "featured"])
      .not("body", "is", null)
      .order("featured", { ascending: false })
      .order("rating", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(24);
    featuredReviews = (reviewsRaw || []).filter(
      (r) => (r as { featured?: boolean; status?: string }).featured === true || (r as { status?: string }).status === "featured",
    );
    const { data: firstProduct } = await admin
      .from("products")
      .select("handle")
      .eq("id", lineProductIds[0] as string)
      .maybeSingle();
    primaryProductHandle = (firstProduct as { handle?: string } | null)?.handle || null;
  }

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
          storefront_slug: workspace?.storefront_slug || null,
          meta_pixel_id: metaPixelId,
          skip_customize: !!(workspace as { storefront_skip_customize?: boolean })?.storefront_skip_customize,
          shipping_protection: workspace?.shipping_protection_enabled
            ? {
                price_cents: (workspace?.shipping_protection_price_cents as number) || 495,
                title: (workspace?.shipping_protection_title as string) || "Shipping protection",
                description: (workspace?.shipping_protection_description as string) || "Protect this order against loss, damage or theft during shipping.",
              }
            : null,
        }}
        sourceProductHandle={(cart as { source_product_handle?: string | null }).source_product_handle || null}
        featuredReviews={featuredReviews as unknown as Parameters<typeof CheckoutClient>[0]["featuredReviews"]}
        primaryProductHandle={primaryProductHandle}
        initialFirstName={initialFirstName}
        initialLastName={initialLastName}
      />
    </main>
  );
}
