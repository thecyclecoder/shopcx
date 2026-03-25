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

  const { data: rules } = await admin
    .from("rules")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("priority", { ascending: false });

  return NextResponse.json(rules || []);
}

export async function POST(
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

  const { data: rule, error } = await admin
    .from("rules")
    .insert({
      workspace_id: workspaceId,
      name: body.name || "Untitled Rule",
      description: body.description || null,
      enabled: body.enabled ?? true,
      trigger_events: body.trigger_events || [],
      conditions: body.conditions || { operator: "AND", groups: [] },
      actions: body.actions || [],
      priority: body.priority ?? 0,
      stop_processing: body.stop_processing ?? false,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(rule, { status: 201 });
}
