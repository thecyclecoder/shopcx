import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET: List fraud cases with filters
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const ruleType = url.searchParams.get("rule_type");
  const severity = url.searchParams.get("severity");
  const limit = parseInt(url.searchParams.get("limit") || "25");
  const offset = parseInt(url.searchParams.get("offset") || "0");

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Check admin/owner role
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let query = admin
    .from("fraud_cases")
    .select("*, fraud_rules(name)", { count: "exact" })
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const customerId = new URL(request.url).searchParams.get("customer_id");
  if (customerId) query = query.contains("customer_ids", [customerId]);
  if (status) query = query.eq("status", status);
  if (ruleType) query = query.eq("rule_type", ruleType);
  if (severity) query = query.eq("severity", severity);

  const { data: cases, count, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Compute stats
  const { data: stats } = await admin.rpc("fraud_case_stats", {
    p_workspace_id: workspaceId,
  });

  // Resolve customer names and order numbers for display
  const allCustomerIds = [...new Set((cases || []).flatMap(c => (c.customer_ids as string[]) || []))];
  const allOrderIds = [...new Set((cases || []).flatMap(c => (c.order_ids as string[]) || []))];

  const customerMap = new Map<string, string>();
  const orderMap = new Map<string, string>();

  if (allCustomerIds.length) {
    const { data: customers } = await admin.from("customers")
      .select("id, first_name, last_name, email")
      .in("id", allCustomerIds);
    for (const c of customers || []) {
      const name = [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "Unknown";
      customerMap.set(c.id, name);
    }
  }

  if (allOrderIds.length) {
    // order_ids in fraud_cases stores shopify_order_id (text), but one code path stores internal UUIDs — look up by both.
    const { data: ordersByShopifyId } = await admin.from("orders")
      .select("id, shopify_order_id, order_number")
      .in("shopify_order_id", allOrderIds);
    for (const o of ordersByShopifyId || []) {
      if (o.shopify_order_id) orderMap.set(o.shopify_order_id, o.order_number || o.shopify_order_id);
    }
    const missing = allOrderIds.filter(id => !orderMap.has(id));
    if (missing.length) {
      const { data: ordersByUuid } = await admin.from("orders")
        .select("id, order_number")
        .in("id", missing);
      for (const o of ordersByUuid || []) {
        orderMap.set(o.id, o.order_number || o.id);
      }
    }
  }

  const enrichedCases = (cases || []).map(c => ({
    ...c,
    customer_names: ((c.customer_ids as string[]) || []).map(id => customerMap.get(id) || "Unknown"),
    order_numbers: ((c.order_ids as string[]) || []).map(id => orderMap.get(id) || "?"),
  }));

  return NextResponse.json({
    cases: enrichedCases,
    total: count || 0,
    stats: stats?.[0] || { open_count: 0, confirmed_30d: 0, dismissed_30d: 0, value_at_risk_cents: 0 },
  });
}
