import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const reason = searchParams.get("reason");
  const sort = searchParams.get("sort") || "created_at";
  const order = searchParams.get("order") || "desc";
  const limit = Math.min(parseInt(searchParams.get("limit") || "25"), 100);
  const offset = parseInt(searchParams.get("offset") || "0");

  const admin = createAdminClient();

  let query = admin
    .from("chargeback_events")
    .select(
      "*, customers(id, email, first_name, last_name, retention_score)",
      { count: "exact" }
    )
    .eq("workspace_id", workspaceId);

  if (status && status !== "all") query = query.eq("status", status);
  if (reason) query = query.eq("reason", reason);

  const validSorts = ["created_at", "amount_cents", "evidence_due_by", "status"];
  const sortCol = validSorts.includes(sort) ? sort : "created_at";
  query = query.order(sortCol, { ascending: order === "asc" });
  query = query.range(offset, offset + limit - 1);

  const { data, count, error } = await query;

  if (error) {
    console.error("Chargebacks list error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Fetch order numbers for display
  const orderIds = [...new Set((data || []).map(d => d.shopify_order_id).filter(Boolean))];
  let orderMap: Record<string, string> = {};
  if (orderIds.length > 0) {
    const { data: orders } = await admin
      .from("orders")
      .select("shopify_order_id, order_number")
      .eq("workspace_id", workspaceId)
      .in("shopify_order_id", orderIds);

    if (orders) {
      orderMap = Object.fromEntries(orders.map(o => [o.shopify_order_id, o.order_number]));
    }
  }

  const enriched = (data || []).map(cb => ({
    ...cb,
    order_number: cb.shopify_order_id ? orderMap[cb.shopify_order_id] || null : null,
  }));

  return NextResponse.json({ data: enriched, total: count || 0 });
}
