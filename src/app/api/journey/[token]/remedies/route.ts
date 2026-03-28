import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { selectRemedies, isConcreteReason } from "@/lib/remedy-selector";

/**
 * POST: Get AI-selected remedies for a cancel journey.
 * Called after customer selects their cancel reason.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const admin = createAdminClient();

  const { data: session } = await admin
    .from("journey_sessions")
    .select("id, workspace_id, customer_id, config_snapshot, status")
    .eq("token", token)
    .single();

  if (!session) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (session.status === "completed") return NextResponse.json({ error: "already_completed" }, { status: 400 });

  const body = await request.json();
  const { cancel_reason, subscription_id } = body as { cancel_reason: string; subscription_id?: string };

  if (!cancel_reason) return NextResponse.json({ error: "cancel_reason required" }, { status: 400 });

  const config = session.config_snapshot as { metadata?: { subscriptions?: { id: string; contractId: string; items: { title: string }[]; isFirstRenewal?: boolean; subscriptionAgeDays?: number }[] } };
  const metadata = config.metadata || {};

  // Get subscription's product IDs for review matching
  const selectedSub = subscription_id
    ? (metadata.subscriptions || []).find(s => s.id === subscription_id)
    : (metadata.subscriptions || [])[0];

  // Get customer context
  const { data: customer } = await admin
    .from("customers")
    .select("id, retention_score, shopify_customer_id")
    .eq("id", session.customer_id)
    .single();

  const { data: orders } = await admin
    .from("orders")
    .select("id, total_price_cents")
    .eq("customer_id", session.customer_id)
    .eq("workspace_id", session.workspace_id);

  const totalOrders = orders?.length || 0;
  const ltv = orders?.reduce((sum, o) => sum + (o.total_price_cents || 0), 0) || 0;

  // Calculate subscription age
  const { data: sub } = subscription_id
    ? await admin.from("subscriptions").select("created_at").eq("id", subscription_id).single()
    : { data: null };
  const subAge = sub?.created_at
    ? Math.floor((Date.now() - new Date(sub.created_at).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  const products = selectedSub?.items?.map(i => i.title) || [];

  // Get product Shopify IDs for review matching
  const { data: productRecords } = await admin
    .from("products")
    .select("shopify_product_id, title")
    .eq("workspace_id", session.workspace_id);

  const matchingProductIds = (productRecords || [])
    .filter(p => products.some(name => p.title?.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(p.title?.toLowerCase() || "")))
    .map(p => p.shopify_product_id);

  const concrete = isConcreteReason(cancel_reason);

  const isFirstRenewal = selectedSub?.isFirstRenewal || false;

  if (concrete) {
    const { remedies, review } = await selectRemedies(
      session.workspace_id,
      cancel_reason,
      {
        ltv_cents: ltv,
        retention_score: customer?.retention_score || 50,
        subscription_age_days: subAge,
        total_orders: totalOrders,
        products,
        first_renewal: isFirstRenewal,
      },
      matchingProductIds,
    );

    return NextResponse.json({
      type: "remedies",
      remedies,
      review,
    });
  }

  // Open-ended reason — return signal to start AI chat
  return NextResponse.json({
    type: "ai_chat",
    initial_message: null, // Client will call /chat endpoint for messages
  });
}
