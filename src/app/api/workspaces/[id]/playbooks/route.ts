import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET: List playbooks with policies, exceptions, and steps
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: playbooks } = await admin.from("playbooks")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("priority", { ascending: false });

  const result = [];
  for (const pb of playbooks || []) {
    const { data: policies } = await admin.from("playbook_policies")
      .select("*").eq("playbook_id", pb.id).order("sort_order");
    const { data: exceptions } = await admin.from("playbook_exceptions")
      .select("*").eq("playbook_id", pb.id).order("tier");
    const { data: steps } = await admin.from("playbook_steps")
      .select("*").eq("playbook_id", pb.id).order("step_order");

    result.push({ ...pb, policies: policies || [], exceptions: exceptions || [], steps: steps || [] });
  }

  return NextResponse.json({ playbooks: result });
}

// POST: Create playbook
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const body = await request.json();

  const { data, error } = await admin.from("playbooks").insert({
    workspace_id: workspaceId,
    name: body.name,
    description: body.description || null,
    trigger_intents: body.trigger_intents || [],
    trigger_patterns: body.trigger_patterns || [],
    priority: body.priority || 0,
    is_active: body.is_active ?? true,
    exception_limit: body.exception_limit || 1,
    stand_firm_max: body.stand_firm_max || 3,
  }).select("id").single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data.id });
}

// PATCH: Update playbook
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const body = await request.json();
  const { playbook_id, ...updates } = body;

  if (!playbook_id) return NextResponse.json({ error: "playbook_id required" }, { status: 400 });

  await admin.from("playbooks").update({
    ...updates,
    updated_at: new Date().toISOString(),
  }).eq("id", playbook_id).eq("workspace_id", workspaceId);

  return NextResponse.json({ ok: true });
}

// DELETE: Delete playbook
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const playbookId = url.searchParams.get("id");
  if (!playbookId) return NextResponse.json({ error: "id required" }, { status: 400 });

  const admin = createAdminClient();
  await admin.from("playbooks").delete().eq("id", playbookId).eq("workspace_id", workspaceId);

  return NextResponse.json({ ok: true });
}
