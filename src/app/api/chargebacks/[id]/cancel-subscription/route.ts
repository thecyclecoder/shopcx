import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import { appstleSubscriptionAction } from "@/lib/appstle";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: chargebackEventId } = await params;
  const { subscriptionId } = await request.json();

  if (!subscriptionId) {
    return NextResponse.json({ error: "subscriptionId required" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();

  // Verify role
  const { data: member } = await admin
    .from("workspace_members")
    .select("role, display_name")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const displayName = member.display_name || user.user_metadata?.full_name || user.user_metadata?.name || null;

  // Verify chargeback belongs to workspace
  const { data: cb } = await admin
    .from("chargeback_events")
    .select("id, customer_id")
    .eq("id", chargebackEventId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!cb) return NextResponse.json({ error: "Chargeback not found" }, { status: 404 });

  // Get subscription
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, shopify_contract_id, status, customer_id")
    .eq("id", subscriptionId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!sub || !sub.shopify_contract_id) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
  }

  if (sub.status === "cancelled") {
    return NextResponse.json({ error: "Already cancelled" }, { status: 400 });
  }

  // Cancel via Appstle
  const result = await appstleSubscriptionAction(workspaceId, sub.shopify_contract_id, "cancel", "chargeback", displayName);

  if (result.success) {
    // Log the action
    await admin.from("chargeback_subscription_actions").insert({
      chargeback_event_id: chargebackEventId,
      subscription_id: sub.id,
      customer_id: sub.customer_id,
      workspace_id: workspaceId,
      action: "cancelled",
      cancellation_reason: "chargeback_manual",
      executed_by: user.id,
    });

    // Update chargeback auto_action_taken if not already set
    await admin
      .from("chargeback_events")
      .update({ auto_action_taken: "subscriptions_cancelled", auto_action_at: new Date().toISOString() })
      .eq("id", chargebackEventId)
      .is("auto_action_taken", null);
  }

  return NextResponse.json({ success: result.success, error: result.error });
}
