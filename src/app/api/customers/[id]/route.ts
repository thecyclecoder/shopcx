import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { calculateRetentionScore } from "@/lib/retention-score";

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
    .select("id, shopify_contract_id, status, billing_interval, billing_interval_count, next_billing_date, last_payment_status, items, delivery_price_cents, applied_discounts, created_at, updated_at")
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

  // Recalculate retention score with real data
  const lastOrder = orders?.[0];
  customer.retention_score = calculateRetentionScore({
    last_order_at: lastOrder?.created_at || customer.last_order_at,
    total_orders: customer.total_orders,
    ltv_cents: customer.ltv_cents,
    subscription_status: customer.subscription_status,
  });

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

  // Get tickets across all linked profiles
  const { data: tickets } = await admin
    .from("tickets")
    .select("id, subject, status, channel, tags, created_at, last_customer_reply_at")
    .in("customer_id", linkedCustomerIds)
    .order("created_at", { ascending: false })
    .limit(20);

  // Check if current customer is primary in their link group
  let isPrimary = true; // default if not linked
  if (link) {
    const { data: selfLink } = await admin
      .from("customer_links")
      .select("is_primary")
      .eq("customer_id", customerId)
      .single();
    isPrimary = selfLink?.is_primary ?? true;
  }

  // Find primary customer info for banner on secondary profiles
  let primaryCustomer: { id: string; email: string; first_name: string | null; last_name: string | null } | null = null;
  if (link && !isPrimary) {
    const { data: primaryLink } = await admin
      .from("customer_links")
      .select("customer_id, customers(id, email, first_name, last_name)")
      .eq("group_id", link.group_id)
      .eq("is_primary", true)
      .single();
    if (primaryLink) {
      primaryCustomer = primaryLink.customers as unknown as { id: string; email: string; first_name: string | null; last_name: string | null };
    }
  }

  // Fetch reviews for this customer
  const { data: reviews } = await admin
    .from("product_reviews")
    .select("id, rating, title, body, review_type, status, featured, product_name, published_at")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .order("published_at", { ascending: false })
    .limit(20);

  return NextResponse.json({
    customer,
    orders: orders || [],
    subscriptions: subscriptions || [],
    tickets: tickets || [],
    reviews: reviews || [],
    linked_identities: linkedIdentities,
    group_id: link?.group_id || null,
    is_primary: isPrimary,
    primary_customer: primaryCustomer,
  });
}
