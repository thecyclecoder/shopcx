import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: workspace } = await admin
    .from("workspaces")
    .select("dunning_enabled, dunning_max_card_rotations, dunning_payday_retry_enabled, dunning_cycle_1_action, dunning_cycle_2_action")
    .eq("id", workspaceId)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  return NextResponse.json(workspace);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

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

  const body = await request.json();
  const updates: Record<string, unknown> = {};

  if (typeof body.dunning_enabled === "boolean") updates.dunning_enabled = body.dunning_enabled;
  if (typeof body.dunning_max_card_rotations === "number") updates.dunning_max_card_rotations = body.dunning_max_card_rotations;
  if (typeof body.dunning_payday_retry_enabled === "boolean") updates.dunning_payday_retry_enabled = body.dunning_payday_retry_enabled;
  if (body.dunning_cycle_1_action) updates.dunning_cycle_1_action = body.dunning_cycle_1_action;
  if (body.dunning_cycle_2_action) updates.dunning_cycle_2_action = body.dunning_cycle_2_action;

  const { data, error } = await admin
    .from("workspaces")
    .update(updates)
    .eq("id", workspaceId)
    .select("dunning_enabled, dunning_max_card_rotations, dunning_payday_retry_enabled, dunning_cycle_1_action, dunning_cycle_2_action")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
