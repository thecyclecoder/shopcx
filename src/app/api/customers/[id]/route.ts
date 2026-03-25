import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveWorkspaceId } from "@/lib/workspace";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: customerId } = await params;

  // Suppress unused variable warning
  void request;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaceId = await getActiveWorkspaceId();
  if (!workspaceId)
    return NextResponse.json(
      { error: "No active workspace" },
      { status: 400 }
    );

  const admin = createAdminClient();

  // Verify membership
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Fetch customer
  const { data: customer, error } = await admin
    .from("customers")
    .select("*")
    .eq("id", customerId)
    .eq("workspace_id", workspaceId)
    .single();

  if (error || !customer) {
    return NextResponse.json(
      { error: "Customer not found" },
      { status: 404 }
    );
  }

  // Fetch recent orders (including linked customer orders)
  const linkedCustomerIds = [customerId];

  const { data: link } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", customerId)
    .single();

  if (link) {
    const { data: groupLinks } = await admin
      .from("customer_links")
      .select("customer_id")
      .eq("group_id", link.group_id);

    for (const gl of groupLinks || []) {
      if (!linkedCustomerIds.includes(gl.customer_id)) {
        linkedCustomerIds.push(gl.customer_id);
      }
    }
  }

  const { data: orders } = await admin
    .from("orders")
    .select("*")
    .eq("workspace_id", workspaceId)
    .in("customer_id", linkedCustomerIds)
    .order("created_at", { ascending: false })
    .limit(20);

  const { data: subscriptions } = await admin
    .from("subscriptions")
    .select("id, shopify_contract_id, status, billing_interval, billing_interval_count, next_billing_date, last_payment_status, items, delivery_price_cents, created_at, updated_at")
    .eq("workspace_id", workspaceId)
    .in("customer_id", linkedCustomerIds)
    .order("created_at", { ascending: false });

  // Compute real LTV and order count from DB (source of truth)
  const { count: realOrderCount } = await admin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .in("customer_id", linkedCustomerIds);

  const { data: ltvRows } = await admin
    .from("orders")
    .select("total_cents")
    .in("customer_id", linkedCustomerIds);

  const realLtv = (ltvRows || []).reduce((sum, o) => sum + (o.total_cents || 0), 0);

  // Override stored values with computed values
  customer.total_orders = realOrderCount || customer.total_orders;
  customer.ltv_cents = realLtv || customer.ltv_cents;

  // Get linked identities
  let linkedIdentities: { id: string; email: string; first_name: string | null; last_name: string | null; is_primary: boolean }[] = [];
  if (link) {
    const { data: groupLinks } = await admin
      .from("customer_links")
      .select("customer_id, is_primary, customers(id, email, first_name, last_name)")
      .eq("group_id", link.group_id);

    linkedIdentities = (groupLinks || [])
      .filter((l) => l.customer_id !== customerId)
      .map((l) => {
        const c = l.customers as unknown as { id: string; email: string; first_name: string | null; last_name: string | null };
        return {
          id: c.id,
          email: c.email,
          first_name: c.first_name,
          last_name: c.last_name,
          is_primary: l.is_primary,
        };
      });
  }

  return NextResponse.json({
    customer,
    orders: orders || [],
    subscriptions: subscriptions || [],
    linked_identities: linkedIdentities,
    group_id: link?.group_id || null,
  });
}
