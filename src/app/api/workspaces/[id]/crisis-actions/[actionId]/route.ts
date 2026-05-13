import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Per-row API for crisis_customer_actions:
 *
 *   GET     → single action + its parent crisis_event (used by the
 *             ticket-sidebar enrollment card to render current state).
 *   PATCH   → flip the agent-controllable flags inline: auto_resume,
 *             auto_readd, cancelled. We deliberately don't expose the
 *             tier1/2/3 response fields here — those are set by the
 *             actual journey/playbook execution.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; actionId: string }> },
) {
  const { id: workspaceId, actionId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: action } = await admin
    .from("crisis_customer_actions")
    .select("id, crisis_id, segment, current_tier, paused_at, auto_resume, removed_item_at, auto_readd, cancelled, ticket_id, subscription_id, original_item, created_at, updated_at")
    .eq("id", actionId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!action) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: crisis } = await admin
    .from("crisis_events")
    .select("id, name, status, affected_product_title, default_swap_title, expected_restock_date")
    .eq("id", action.crisis_id)
    .single();

  return NextResponse.json({ action, crisis });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; actionId: string }> },
) {
  const { id: workspaceId, actionId } = await params;
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
  if (!member || !["owner", "admin", "agent"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.auto_resume === "boolean") update.auto_resume = body.auto_resume;
  if (typeof body.auto_readd === "boolean") update.auto_readd = body.auto_readd;
  if (typeof body.cancelled === "boolean") update.cancelled = body.cancelled;

  if (Object.keys(update).length === 1) {
    return NextResponse.json({ error: "No editable fields" }, { status: 400 });
  }

  const { error } = await admin
    .from("crisis_customer_actions")
    .update(update)
    .eq("id", actionId)
    .eq("workspace_id", workspaceId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
