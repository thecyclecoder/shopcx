/**
 * Thank-you page — final step of the post-Shopify funnel before
 * post-purchase upsells (which land in a future iteration).
 *
 *   PDP → Customize → Checkout → /thank-you?order=...
 *
 * Loads the order + workspace branding server-side. Lightweight client
 * island fires order_placed → checkout_completed on mount so the
 * storefront pixel + CAPI fan-out finalize the funnel.
 */

import { redirect } from "next/navigation";
import { connection } from "next/server";
import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { ThankYouClient } from "./_components/ThankYouClient";
import { getStorefrontMetadata } from "../_lib/storefront-metadata";

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  await connection();
  const params = await searchParams;
  if (!params.order) return {};
  const admin = createAdminClient();
  const { data: order } = await admin
    .from("orders")
    .select("workspace_id")
    .eq("id", params.order)
    .maybeSingle();
  if (!order?.workspace_id) return {};
  return getStorefrontMetadata(order.workspace_id as string, "Thank You");
}

interface PageProps {
  searchParams: Promise<{ order?: string }>;
}


export default async function ThankYouPage({ searchParams }: PageProps) {
  await connection();
  const params = await searchParams;
  if (!params.order) redirect("/");

  const admin = createAdminClient();
  const { data: order } = await admin
    .from("orders")
    .select(
      "id, order_number, email, total_cents, currency, line_items, shipping_address, workspace_id, created_at, payment_details, discount_codes, shipping_protection_amount_cents, avalara_total_tax_cents",
    )
    .eq("id", params.order)
    .maybeSingle();
  if (!order) redirect("/");

  const { data: workspace } = await admin
    .from("workspaces")
    .select("id, name, storefront_primary_color, storefront_logo_url")
    .eq("id", order.workspace_id)
    .single();

  const { getMetaPixelId } = await import("@/lib/meta-capi");
  const metaPixelId = await getMetaPixelId(order.workspace_id as string);

  // Savings = MSRP subtotal − what they paid (mirrors the cart + confirmation
  // email "You saved" treatment).
  const orderLines = (order.line_items as Array<Record<string, unknown>>) || [];
  const lineUnit = (l: Record<string, unknown>) => (Number(l.unit_price_cents) || Number(l.price_cents) || 0);
  const paidSubtotal = (order.payment_details as { subtotal_cents?: number } | null)?.subtotal_cents
    ?? orderLines.reduce((s, l) => s + (Number(l.line_total_cents) || lineUnit(l) * (Number(l.quantity) || 1)), 0);
  const msrpSubtotal = orderLines.reduce((s, l) => s + (Number(l.unit_msrp_cents) || lineUnit(l)) * (Number(l.quantity) || 1), 0);
  const savingsCents = Math.max(0, msrpSubtotal - paidSubtotal);

  // Order-total breakdown for the summary. The discount amount isn't stored as its own column
  // (only the codes), so derive it from the authoritative total:
  //   total = subtotal − discount + shipping_protection + tax  →  discount = subtotal + prot + tax − total.
  const shippingProtectionCents = Number(order.shipping_protection_amount_cents) || 0;
  const taxCents = Number(order.avalara_total_tax_cents) || 0;
  const discountCents = Math.max(0, paidSubtotal + shippingProtectionCents + taxCents - (order.total_cents as number));
  const discountCode = Array.isArray(order.discount_codes) && order.discount_codes.length ? String(order.discount_codes[0]) : null;

  // One featured review on a purchased product for post-purchase reassurance.
  const productIds = Array.from(new Set(orderLines.map((l) => l.product_id).filter((id): id is string => typeof id === "string")));
  let review: { reviewer_name: string | null; rating: number; body: string | null } | null = null;
  if (productIds.length > 0) {
    const { data: rev } = await admin
      .from("product_reviews")
      .select("reviewer_name, rating, body")
      .eq("workspace_id", order.workspace_id)
      .in("product_id", productIds)
      .eq("featured", true)
      .not("body", "is", null)
      .limit(1)
      .maybeSingle();
    if (rev) review = { reviewer_name: (rev.reviewer_name as string | null), rating: (rev.rating as number), body: (rev.body as string | null) };
  }

  return (
    <main className="min-h-screen bg-zinc-50">
      <ThankYouClient
        order={{
          id: order.id,
          order_number: order.order_number,
          email: order.email,
          total_cents: order.total_cents,
          currency: order.currency || "USD",
          line_items: (order.line_items as Array<Record<string, unknown>>) || [],
          shipping_address: order.shipping_address as Record<string, string> | null,
          savings_cents: savingsCents,
          subtotal_cents: paidSubtotal,
          discount_cents: discountCents,
          discount_code: discountCode,
          shipping_protection_cents: shippingProtectionCents,
          tax_cents: taxCents,
        }}
        workspace={{
          id: workspace?.id || order.workspace_id,
          name: workspace?.name || "Store",
          logo_url: workspace?.storefront_logo_url || null,
          primary_color: workspace?.storefront_primary_color || "#18181b",
          meta_pixel_id: metaPixelId,
        }}
        review={review}
      />
    </main>
  );
}
