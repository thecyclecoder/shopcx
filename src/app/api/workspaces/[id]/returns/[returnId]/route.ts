// GET: Return detail with customer, order, ticket joins
// PATCH: Update tracking, status

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { attachReturnTracking } from "@/lib/shopify-returns";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; returnId: string }> }
) {
  const { id: workspaceId, returnId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: returnRow, error } = await admin
    .from("returns")
    .select(`
      *,
      customers(id, email, first_name, last_name, phone, shopify_customer_id,
        retention_score, subscription_status, ltv_cents, total_orders),
      orders(id, order_number, total_cents, financial_status, fulfillment_status,
        line_items, fulfillments, created_at),
      tickets(id, subject, status, channel, created_at)
    `)
    .eq("id", returnId)
    .eq("workspace_id", workspaceId)
    .single();

  if (error || !returnRow) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(returnRow);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; returnId: string }> }
) {
  const { id: workspaceId, returnId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const admin = createAdminClient();

  // Handle tracking attachment via Shopify API
  if (body.trackingNumber && body.carrier) {
    try {
      const result = await attachReturnTracking(workspaceId, {
        returnId,
        trackingNumber: body.trackingNumber,
        trackingUrl: body.trackingUrl,
        carrier: body.carrier,
        labelUrl: body.labelUrl,
      });
      return NextResponse.json({ success: true, ...result });
    } catch (err) {
      console.error("Attach tracking error:", err);
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  // Generic status/field updates
  const allowedFields = [
    "status", "tracking_number", "carrier", "label_url",
    "shipped_at", "delivered_at", "processed_at", "refunded_at",
    "net_refund_cents", "label_cost_cents", "refund_id",
  ];

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  const { data, error } = await admin
    .from("returns")
    .update(updates)
    .eq("id", returnId)
    .eq("workspace_id", workspaceId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}
