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

  const { data } = await admin
    .from("ai_workflows")
    .select("*, macros:preferred_macro_id(id, name), workflows:post_response_workflow_id(id, name)")
    .eq("workspace_id", workspaceId)
    .order("priority", { ascending: false });

  return NextResponse.json(data || []);
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
  const { name, description, trigger_intent, match_patterns, match_categories, response_source, preferred_macro_id, preferred_kb_ids, allowed_actions, post_response_workflow_id, config } = body;

  if (!name || !trigger_intent) {
    return NextResponse.json({ error: "Name and trigger_intent required" }, { status: 400 });
  }

  const { data, error } = await admin
    .from("ai_workflows")
    .insert({
      workspace_id: workspaceId,
      name,
      description: description || null,
      trigger_intent,
      match_patterns: match_patterns || [],
      match_categories: match_categories || [],
      response_source: response_source || "either",
      preferred_macro_id: preferred_macro_id || null,
      preferred_kb_ids: preferred_kb_ids || [],
      allowed_actions: allowed_actions || [],
      post_response_workflow_id: post_response_workflow_id || null,
      config: config || {},
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
