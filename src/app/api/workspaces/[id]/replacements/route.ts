import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET — list replacements with filters + pagination
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const url = new URL(request.url);

  const status = url.searchParams.get("status");
  const reason = url.searchParams.get("reason");
  const customerId = url.searchParams.get("customer_id");
  const ticketId = url.searchParams.get("ticket_id");
  const subscriptionId = url.searchParams.get("subscription_id");
  const orderId = url.searchParams.get("order_id");
  const sort = url.searchParams.get("sort") || "created_at";
  const order = url.searchParams.get("order") || "desc";
  const limit = parseInt(url.searchParams.get("limit") || "25");
  const offset = parseInt(url.searchParams.get("offset") || "0");

  let query = admin
    .from("replacements")
    .select("*, customers(id, first_name, last_name, email)", { count: "exact" })
    .eq("workspace_id", workspaceId);

  if (status && status !== "all") query = query.eq("status", status);
  if (reason && reason !== "all") query = query.eq("reason", reason);
  if (customerId) query = query.eq("customer_id", customerId);
  if (ticketId) query = query.eq("ticket_id", ticketId);
  if (subscriptionId) query = query.eq("subscription_id", subscriptionId);
  if (orderId) query = query.eq("original_order_id", orderId);

  query = query.order(sort, { ascending: order === "asc" });
  query = query.range(offset, offset + limit - 1);

  const { data: replacements, count } = await query;

  return NextResponse.json({ replacements: replacements || [], total: count || 0 });
}

// POST — create a new replacement record
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const body = await request.json();
  const {
    customer_id,
    original_order_id,
    original_order_number,
    reason,
    reason_detail,
    items,
    customer_error,
    ticket_id,
    subscription_id,
  } = body;

  if (!customer_id || !reason) {
    return NextResponse.json({ error: "customer_id and reason are required" }, { status: 400 });
  }

  // Check replacement limit for customer errors
  if (customer_error) {
    const { count } = await admin
      .from("replacements")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customer_id)
      .eq("customer_error", true)
      .neq("status", "denied");

    if ((count || 0) >= 1) {
      return NextResponse.json({
        error: "Customer has already received a replacement for a customer error. Limit: 1 per customer.",
        code: "REPLACEMENT_LIMIT_REACHED",
      }, { status: 409 });
    }
  }

  // Refused orders never get replacements
  if (reason === "refused") {
    return NextResponse.json({
      error: "Refused orders are not eligible for replacement. Escalate to admin.",
      code: "REFUSED_NOT_ELIGIBLE",
    }, { status: 409 });
  }

  const { data: replacement, error } = await admin
    .from("replacements")
    .insert({
      workspace_id: workspaceId,
      customer_id,
      original_order_id: original_order_id || null,
      original_order_number: original_order_number || null,
      reason,
      reason_detail: reason_detail || null,
      items: items || null,
      customer_error: customer_error || false,
      ticket_id: ticket_id || null,
      subscription_id: subscription_id || null,
      status: "pending",
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(replacement, { status: 201 });
}
