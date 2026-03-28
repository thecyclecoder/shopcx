import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { appstleSubscriptionAction } from "@/lib/appstle";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; caseId: string }> }
) {
  const { id: workspaceId, caseId } = await params;
  const { subscriptionId } = await request.json();

  if (!subscriptionId) {
    return NextResponse.json({ error: "subscriptionId required" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  // Verify fraud case
  const { data: fraudCase } = await admin
    .from("fraud_cases")
    .select("id")
    .eq("id", caseId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!fraudCase) return NextResponse.json({ error: "Case not found" }, { status: 404 });

  // Get subscription
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, shopify_contract_id, status, customer_id")
    .eq("id", subscriptionId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!sub?.shopify_contract_id) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
  }
  if (sub.status === "cancelled") {
    return NextResponse.json({ error: "Already cancelled" }, { status: 400 });
  }

  const result = await appstleSubscriptionAction(workspaceId, sub.shopify_contract_id, "cancel", "fraud");

  if (result.success) {
    // Add history entry
    await admin.from("fraud_case_history").insert({
      case_id: caseId,
      workspace_id: workspaceId,
      user_id: user.id,
      action: "subscription_cancelled",
      new_value: sub.shopify_contract_id,
      notes: `Subscription ${sub.shopify_contract_id} cancelled for fraud`,
    });
  }

  return NextResponse.json({ success: result.success, error: result.error });
}
