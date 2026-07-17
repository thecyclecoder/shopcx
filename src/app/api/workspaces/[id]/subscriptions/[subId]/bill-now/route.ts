import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { subscriptionOrderNow } from "@/lib/commerce/subscription";
import { logCustomerEvent } from "@/lib/customer-events";
import { guardAppstleOrderNow } from "@/lib/portal/order-now-guard";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; subId: string }> }
) {
  const { id: workspaceId, subId } = await params;
  void request;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: sub } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, customer_id, is_internal, status")
    .eq("id", subId).eq("workspace_id", workspaceId).single();

  if (!sub) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Same gate as the portal handler — a cancelled Appstle contract's
  // attempt-billing call surfaces a stale/misleading error (ticket 183d28b9).
  // See [[/src/lib/portal/order-now-guard]].
  const guard = guardAppstleOrderNow({ is_internal: sub.is_internal, status: sub.status });
  if (guard.action === "block") {
    return NextResponse.json({ error: guard.reason, message: guard.message }, { status: 409 });
  }

  // Flavor-aware order-now: internal subs fire the Braintree renewal pipeline,
  // Appstle subs attempt the upcoming Appstle billing. Calling appstle directly
  // here silently no-ops on internal subs (appstleAttemptBilling short-circuits a
  // synthetic internal-* id to fake success), so order-now must go through this.
  const result = await subscriptionOrderNow(workspaceId, sub.shopify_contract_id);

  if (!result.success) {
    return NextResponse.json({ error: result.error || "Billing failed" }, { status: 500 });
  }

  if (sub.customer_id) {
    await logCustomerEvent({
      workspaceId, customerId: sub.customer_id,
      eventType: "subscription.bill_now", source: "agent",
      summary: result.internal
        ? "Immediate renewal triggered by agent (internal sub)"
        : "Immediate billing triggered by agent",
      properties: { shopify_contract_id: sub.shopify_contract_id, internal: !!result.internal },
    });
  }

  return NextResponse.json({ ok: true });
}
