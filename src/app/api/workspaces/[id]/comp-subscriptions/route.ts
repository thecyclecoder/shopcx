import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Customers → Comp Subscriptions list. Every comp=true sub in the workspace — the
// standing free-product roster (employees / influencers / investors / owners), grouped
// by the customer's comp_role (the allowlist). See docs/brain/specs/comp-subscriptions.md.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const url = new URL(request.url);

  const role = url.searchParams.get("role"); // employee | influencer | investor | owner | all
  const search = url.searchParams.get("search");
  const sort = url.searchParams.get("sort") || "next_billing_date";
  const order = url.searchParams.get("order") || "asc";

  let query = admin
    .from("subscriptions")
    .select(`
      id, shopify_contract_id, status,
      items, billing_interval, billing_interval_count,
      next_billing_date, comp, comp_note, created_at, customer_id,
      customers!inner(id, email, first_name, last_name, comp_role, comp_note)
    `, { count: "exact" })
    .eq("workspace_id", workspaceId)
    .eq("comp", true);

  // Role filter (lives on the customer — the allowlist).
  if (role && role !== "all") {
    query = query.eq("customers.comp_role", role);
  }

  // Search by customer name/email.
  if (search) {
    const { data: matchingCustomers } = await admin
      .from("customers")
      .select("id")
      .eq("workspace_id", workspaceId)
      .or(`email.ilike.%${search}%,first_name.ilike.%${search}%,last_name.ilike.%${search}%`);
    const customerIds = (matchingCustomers || []).map(c => c.id);
    if (customerIds.length === 0) {
      return NextResponse.json({ subscriptions: [], total: 0, role_counts: {} });
    }
    query = query.in("customer_id", customerIds);
  }

  const validSorts: Record<string, string> = {
    next_billing_date: "next_billing_date",
    created_at: "created_at",
    status: "status",
  };
  const sortCol = validSorts[sort] || "next_billing_date";
  query = query.order(sortCol, { ascending: order === "asc" });

  const { data: subscriptions, count, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Role counts for the group tabs — every comp=true sub joined to an allowlisted customer,
  // regardless of the current role/search filter, so the tab badges are stable.
  const { data: allComp } = await admin
    .from("subscriptions")
    .select("id, customers!inner(comp_role)")
    .eq("workspace_id", workspaceId)
    .eq("comp", true);
  const role_counts: Record<string, number> = {};
  for (const s of allComp || []) {
    const c = s.customers as unknown as { comp_role: string | null } | null;
    const r = c?.comp_role || "unassigned";
    role_counts[r] = (role_counts[r] || 0) + 1;
  }

  return NextResponse.json({
    subscriptions: subscriptions || [],
    total: count || 0,
    role_counts,
  });
}
