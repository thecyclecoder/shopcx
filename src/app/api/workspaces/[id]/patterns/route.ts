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

  // Get global + workspace patterns
  const { data: patterns } = await admin
    .from("smart_patterns")
    .select("*")
    .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`)
    .order("priority", { ascending: false });

  // Get workspace overrides
  const { data: overrides } = await admin
    .from("workspace_pattern_overrides")
    .select("pattern_id, enabled")
    .eq("workspace_id", workspaceId);

  const overrideMap = new Map<string, boolean>();
  for (const o of overrides || []) {
    overrideMap.set(o.pattern_id, o.enabled);
  }

  // Enrich patterns with override status
  const enriched = (patterns || []).map((p) => ({
    ...p,
    is_global: !p.workspace_id,
    workspace_enabled: p.workspace_id ? p.active : (overrideMap.get(p.id) ?? true),
  }));

  return NextResponse.json(enriched);
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

  const { data: pattern, error } = await admin
    .from("smart_patterns")
    .insert({
      workspace_id: workspaceId,
      category: body.category || "custom",
      name: body.name || "Untitled Pattern",
      phrases: body.phrases || [],
      match_target: body.match_target || "both",
      priority: body.priority ?? 50,
      auto_tag: body.auto_tag || null,
      auto_action: body.auto_action || null,
      source: "manual",
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(pattern, { status: 201 });
}
