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

  const { data: journeys } = await admin
    .from("journey_definitions")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  // Get stats for each journey
  const enriched = [];
  for (const j of journeys || []) {
    const { count: sent } = await admin.from("journey_sessions").select("id", { count: "exact", head: true }).eq("journey_id", j.id);
    const { count: completed } = await admin.from("journey_sessions").select("id", { count: "exact", head: true }).eq("journey_id", j.id).eq("status", "completed");
    const { count: saved } = await admin.from("journey_sessions").select("id", { count: "exact", head: true }).eq("journey_id", j.id).eq("status", "completed").like("outcome", "saved_%");
    const { count: cancelled } = await admin.from("journey_sessions").select("id", { count: "exact", head: true }).eq("journey_id", j.id).eq("status", "completed").eq("outcome", "cancelled");

    enriched.push({
      ...j,
      stats: { sent: sent || 0, completed: completed || 0, saved: saved || 0, cancelled: cancelled || 0 },
    });
  }

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
  const { slug, name, journey_type, config } = body;

  if (!slug || !name || !journey_type) {
    return NextResponse.json({ error: "slug, name, and journey_type required" }, { status: 400 });
  }

  const { data, error } = await admin
    .from("journey_definitions")
    .insert({ workspace_id: workspaceId, slug, name, journey_type, config: config || {} })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
