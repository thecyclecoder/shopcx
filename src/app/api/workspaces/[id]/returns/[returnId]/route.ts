import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { attachReturnTracking } from "@/lib/shopify-returns";

// GET — return detail with customer, order, ticket joins
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; returnId: string }> },
) {
  const { id: workspaceId, returnId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: ret, error } = await admin
    .from("returns")
    .select(`
      *,
      customers(id, email, first_name, last_name, shopify_customer_id, retention_score, ltv_cents),
      orders(id, order_number, total_cents, financial_status, fulfillment_status, line_items, created_at),
      tickets(id, subject, status, channel)
    `)
    .eq("id", returnId)
    .eq("workspace_id", workspaceId)
    .single();

  if (error || !ret) {
    return NextResponse.json({ error: "Return not found" }, { status: 404 });
  }

  // LTV comes live from the orders table.
  const customer = ret.customers as { id: string } | null;
  if (customer?.id) {
    const { getCustomerStats } = await import("@/lib/customer-stats");
    const stats = await getCustomerStats(customer.id);
    (ret.customers as Record<string, unknown>).ltv_cents = stats.ltv_cents;
  }

  return NextResponse.json(ret);
}

// PATCH — update tracking, status
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; returnId: string }> },
) {
  const { id: workspaceId, returnId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const admin = createAdminClient();

  // If tracking info provided, attach via Shopify API
  if (body.trackingNumber && body.carrier) {
    const result = await attachReturnTracking(workspaceId, {
      returnId,
      trackingNumber: body.trackingNumber,
      trackingUrl: body.trackingUrl,
      carrier: body.carrier,
      labelUrl: body.labelUrl,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  }

  // Otherwise, direct field updates (status, etc.)
  const allowedFields = ["status", "tracking_number", "carrier", "label_url", "shipped_at", "delivered_at"];
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  const { error } = await admin
    .from("returns")
    .update(updates)
    .eq("id", returnId)
    .eq("workspace_id", workspaceId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
