import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * PATCH: update one reseller row. Used by the UI to flip status
 * (active/dormant/whitelisted) or update notes. Logs every status
 * change to fraud_action_log for the audit trail.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; resellerId: string }> },
) {
  const { id: workspaceId, resellerId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};
  if (typeof body.status === "string" && ["active", "dormant", "whitelisted", "unverified"].includes(body.status)) {
    updates.status = body.status;
  }
  if (typeof body.notes === "string") updates.notes = body.notes;
  if (!Object.keys(updates).length) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  // Capture old values for the audit log
  const { data: prior } = await admin.from("known_resellers")
    .select("status, notes, business_name, amazon_seller_id")
    .eq("id", resellerId).eq("workspace_id", workspaceId).single();
  if (!prior) return NextResponse.json({ error: "Not found" }, { status: 404 });

  updates.updated_at = new Date().toISOString();
  const { error } = await admin.from("known_resellers")
    .update(updates).eq("id", resellerId).eq("workspace_id", workspaceId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (updates.status && updates.status !== prior.status) {
    await admin.from("fraud_action_log").insert({
      workspace_id: workspaceId,
      reseller_id: resellerId,
      action: "reseller_status_changed",
      metadata: {
        from: prior.status,
        to: updates.status,
        business_name: prior.business_name,
        amazon_seller_id: prior.amazon_seller_id,
        changed_by: user.email || user.id,
      },
    });
  }

  return NextResponse.json({ ok: true });
}
