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
import { createAdminClient } from "@/lib/supabase/admin";
import { ThankYouClient } from "./_components/ThankYouClient";

interface PageProps {
  searchParams: Promise<{ order?: string }>;
}

export const dynamic = "force-dynamic";

export default async function ThankYouPage({ searchParams }: PageProps) {
  const params = await searchParams;
  if (!params.order) redirect("/");

  const admin = createAdminClient();
  const { data: order } = await admin
    .from("orders")
    .select(
      "id, order_number, email, total_cents, currency, line_items, shipping_address, workspace_id, created_at",
    )
    .eq("id", params.order)
    .maybeSingle();
  if (!order) redirect("/");

  const { data: workspace } = await admin
    .from("workspaces")
    .select("id, name, storefront_primary_color, storefront_logo_url")
    .eq("id", order.workspace_id)
    .single();

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
        }}
        workspace={{
          id: workspace?.id || order.workspace_id,
          name: workspace?.name || "Store",
          logo_url: workspace?.storefront_logo_url || null,
          primary_color: workspace?.storefront_primary_color || "#18181b",
        }}
      />
    </main>
  );
}
