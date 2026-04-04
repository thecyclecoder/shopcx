// GET: List returns with filters, pagination
// POST: Create a new return (agent-initiated)

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createShopifyReturn, getReturnableItems } from "@/lib/shopify-returns";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const url = new URL(request.url);

  // Filters
  const status = url.searchParams.get("status");
  const resolution = url.searchParams.get("resolution");
  const source = url.searchParams.get("source");
  const search = url.searchParams.get("search");
  const limit = parseInt(url.searchParams.get("limit") || "25");
  const offset = parseInt(url.searchParams.get("offset") || "0");

  let query = admin
    .from("returns")
    .select(`
      id, order_number, shopify_order_gid, status, resolution_type, source,
      order_total_cents, label_cost_cents, net_refund_cents,
      tracking_number, carrier, return_line_items,
      shipped_at, delivered_at, processed_at, refunded_at,
      created_at, updated_at, customer_id, order_id, ticket_id,
      customers(id, email, first_name, last_name)
    `, { count: "exact" })
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  if (status && status !== "all") {
    query = query.eq("status", status);
  }

  if (resolution && resolution !== "all") {
    query = query.eq("resolution_type", resolution);
  }

  if (source && source !== "all") {
    query = query.eq("source", source);
  }

  if (search) {
    // Search by order number or customer email/name
    const { data: matchingCustomers } = await admin
      .from("customers")
      .select("id")
      .eq("workspace_id", workspaceId)
      .or(`email.ilike.%${search}%,first_name.ilike.%${search}%,last_name.ilike.%${search}%`);

    const customerIds = (matchingCustomers || []).map(c => c.id);

    // Also check order_number match
    if (customerIds.length > 0) {
      query = query.or(`order_number.ilike.%${search}%,customer_id.in.(${customerIds.join(",")})`);
    } else {
      query = query.ilike("order_number", `%${search}%`);
    }
  }

  query = query.range(offset, offset + limit - 1);

  const { data: returns, count, error } = await query;

  if (error) {
    console.error("Returns list error:", error);
    return NextResponse.json({ error: "Failed to fetch returns" }, { status: 500 });
  }

  return NextResponse.json({ returns: returns || [], total: count || 0 });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const {
    orderId,
    orderNumber,
    shopifyOrderGid,
    customerId,
    ticketId,
    resolutionType,
    returnLineItems,
  } = body;

  if (!orderId || !orderNumber || !shopifyOrderGid || !customerId || !resolutionType) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  try {
    // If no line items provided, get all returnable items
    let items = returnLineItems;
    if (!items || items.length === 0) {
      items = await getReturnableItems(workspaceId, shopifyOrderGid);
      if (items.length === 0) {
        return NextResponse.json({ error: "No returnable items found for this order" }, { status: 400 });
      }
    }

    const result = await createShopifyReturn(workspaceId, {
      orderId,
      orderNumber,
      shopifyOrderGid,
      customerId,
      ticketId,
      resolutionType,
      returnLineItems: items,
      source: "agent",
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    console.error("Create return error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
