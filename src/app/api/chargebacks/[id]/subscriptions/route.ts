import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: chargebackEventId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();

  // Get the chargeback event and its customer
  const { data: cb } = await admin
    .from("chargeback_events")
    .select("customer_id")
    .eq("id", chargebackEventId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!cb?.customer_id) return NextResponse.json({ subscriptions: [] });

  // Get linked customer IDs
  const customerIds = [cb.customer_id];
  const { data: links } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", cb.customer_id)
    .single();

  if (links?.group_id) {
    const { data: grouped } = await admin
      .from("customer_links")
      .select("customer_id")
      .eq("group_id", links.group_id);
    if (grouped) {
      for (const g of grouped) {
        if (!customerIds.includes(g.customer_id)) {
          customerIds.push(g.customer_id);
        }
      }
    }
  }

  // Fetch active/paused subscriptions across all linked customers
  const { data: subs } = await admin
    .from("subscriptions")
    .select("id, shopify_contract_id, status, items, next_billing_date, billing_interval, customer_id, customers(email, first_name, last_name)")
    .eq("workspace_id", workspaceId)
    .in("customer_id", customerIds)
    .in("status", ["active", "paused"]);

  return NextResponse.json({
    subscriptions: (subs || []).map((s) => {
      const cust = s.customers as unknown as { email: string; first_name: string | null; last_name: string | null } | null;
      const items = (s.items as { title?: string }[] | null) || [];
      return {
        id: s.id,
        shopify_contract_id: s.shopify_contract_id,
        status: s.status,
        items: items.map((i) => i.title || "Unknown").join(", "),
        next_billing_date: s.next_billing_date,
        billing_interval: s.billing_interval,
        customer_email: cust?.email || "",
        customer_name: `${cust?.first_name || ""} ${cust?.last_name || ""}`.trim(),
        is_linked: s.customer_id !== cb.customer_id,
      };
    }),
  });
}
