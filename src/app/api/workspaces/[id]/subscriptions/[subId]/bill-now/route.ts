import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { appstleGetUpcomingOrders, appstleAttemptBilling } from "@/lib/appstle";
import { logCustomerEvent } from "@/lib/customer-events";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; subId: string }> }
) {
  const { id: workspaceId, subId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: sub } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, customer_id")
    .eq("id", subId).eq("workspace_id", workspaceId).single();

  if (!sub) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Get upcoming order to get billing attempt ID
  const ordersRes = await appstleGetUpcomingOrders(workspaceId, sub.shopify_contract_id);
  if (!ordersRes.success || !ordersRes.orders?.length) {
    return NextResponse.json({ error: "No upcoming orders found" }, { status: 400 });
  }

  const billingAttemptId = ordersRes.orders[0].id;
  const result = await appstleAttemptBilling(workspaceId, billingAttemptId);

  if (!result.success) {
    return NextResponse.json({ error: result.error || "Billing failed" }, { status: 500 });
  }

  if (sub.customer_id) {
    await logCustomerEvent({
      workspaceId, customerId: sub.customer_id,
      eventType: "subscription.bill_now", source: "agent",
      summary: "Immediate billing triggered by agent",
      properties: { shopify_contract_id: sub.shopify_contract_id, billingAttemptId },
    });
  }

  return NextResponse.json({ ok: true });
}
