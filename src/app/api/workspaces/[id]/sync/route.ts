import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncCustomers, syncOrders } from "@/lib/shopify-sync";
import { updateRetentionScores } from "@/lib/retention-score";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  // Suppress unused variable warning
  void request;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  try {
    const customersSynced = await syncCustomers(workspaceId);
    const ordersSynced = await syncOrders(workspaceId);
    await updateRetentionScores(workspaceId);

    return NextResponse.json({
      customers_synced: customersSynced,
      orders_synced: ordersSynced,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
