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

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: cb } = await admin
    .from("chargeback_events")
    .select("id, customer_id, workspace_id")
    .eq("id", chargebackEventId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!cb) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: actions } = await admin
    .from("chargeback_subscription_actions")
    .select("subscription_id, subscriptions(id, shopify_contract_id, status)")
    .eq("chargeback_event_id", chargebackEventId)
    .eq("action", "cancelled");

  if (!actions || actions.length === 0) {
    return NextResponse.json({ error: "No cancelled subscriptions to reinstate" }, { status: 400 });
  }

  const results: { subscription_id: string; success: boolean; error?: string }[] = [];

  for (const action of actions) {
    const sub = action.subscriptions as unknown as { id: string; shopify_contract_id: string; status: string } | null;
    if (!sub || !sub.shopify_contract_id || sub.status !== "cancelled") continue;

    // Sets status to ACTIVE in Appstle via v2 API
    const result = await appstleSubscriptionAction(workspaceId, sub.shopify_contract_id, "resume");
    results.push({ subscription_id: sub.id, ...result });

    if (result.success) {
      await admin.from("chargeback_subscription_actions").insert({
        chargeback_event_id: chargebackEventId,
        subscription_id: sub.id,
        customer_id: cb.customer_id,
        workspace_id: workspaceId,
        action: "reinstated",
        cancellation_reason: "admin_reinstate_after_chargeback_won",
        executed_by: user.id,
      });
    }
  }

  return NextResponse.json({ results });
}
