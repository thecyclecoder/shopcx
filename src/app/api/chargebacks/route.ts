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

  const customerId = searchParams.get("customer_id");
  if (customerId) query = query.eq("customer_id", customerId);
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

  // Get active subscription counts per customer (including linked accounts)
  const customerIds = [...new Set((data || []).map(d => d.customer_id).filter(Boolean))] as string[];
  const subCountMap: Record<string, number> = {};

  if (customerIds.length > 0) {
    // Resolve linked groups for all customers at once
    const { data: allLinks } = await admin
      .from("customer_links")
      .select("customer_id, group_id")
      .eq("workspace_id", workspaceId)
      .in("customer_id", customerIds);

    // Build map: customer_id → all IDs in their group
    const groupMap = new Map<string, string[]>();
    if (allLinks && allLinks.length > 0) {
      const groupIds = [...new Set(allLinks.map(l => l.group_id))];
      const { data: groupMembers } = await admin
        .from("customer_links")
        .select("customer_id, group_id")
        .in("group_id", groupIds);

      const groupToMembers = new Map<string, string[]>();
      for (const m of groupMembers || []) {
        const arr = groupToMembers.get(m.group_id) || [];
        arr.push(m.customer_id);
        groupToMembers.set(m.group_id, arr);
      }

      for (const l of allLinks) {
        groupMap.set(l.customer_id, groupToMembers.get(l.group_id) || [l.customer_id]);
      }
    }

    // Collect all customer IDs we need to check (including linked)
    const allCustIds = new Set<string>();
    for (const cid of customerIds) {
      const linked = groupMap.get(cid);
      if (linked) {
        for (const id of linked) allCustIds.add(id);
      } else {
        allCustIds.add(cid);
      }
    }

    // Single query for all active/paused subscriptions
    const { data: activeSubs } = await admin
      .from("subscriptions")
      .select("customer_id")
      .eq("workspace_id", workspaceId)
      .in("customer_id", [...allCustIds])
      .in("status", ["active", "paused"]);

    // Count per customer (using expanded group IDs)
    const subsByCustomer = new Map<string, number>();
    for (const s of activeSubs || []) {
      subsByCustomer.set(s.customer_id, (subsByCustomer.get(s.customer_id) || 0) + 1);
    }

    for (const cid of customerIds) {
      const linkedIds = groupMap.get(cid) || [cid];
      let total = 0;
      for (const id of linkedIds) {
        total += subsByCustomer.get(id) || 0;
      }
      subCountMap[cid] = total;
    }
  }

  const enriched = (data || []).map(cb => ({
    ...cb,
    order_number: cb.shopify_order_id ? orderMap[cb.shopify_order_id] || null : null,
    active_sub_count: cb.customer_id ? (subCountMap[cb.customer_id] || 0) : 0,
  }));

  // Sort by active_sub_count if requested (done in-memory since it's computed)
  if (sort === "active_sub_count") {
    enriched.sort((a, b) => order === "asc"
      ? a.active_sub_count - b.active_sub_count
      : b.active_sub_count - a.active_sub_count
    );
  }

  return NextResponse.json({ data: enriched, total: count || 0 });
}
