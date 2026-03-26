import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; journeyId: string }> }
) {
  const { id: workspaceId, journeyId } = await params;

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
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const key of ["name", "slug", "journey_type", "config", "is_active"]) {
    if (body[key] !== undefined) updates[key] = body[key];
  }

  const { data, error } = await admin
    .from("journey_definitions")
    .update(updates)
    .eq("id", journeyId)
    .eq("workspace_id", workspaceId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; journeyId: string }> }
) {
  const { id: workspaceId, journeyId } = await params;
  void request;

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

  await admin.from("journey_definitions").delete().eq("id", journeyId).eq("workspace_id", workspaceId);
  return NextResponse.json({ ok: true });
}

// GET: Journey analytics (sessions, funnel, outcomes)
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; journeyId: string }> }
) {
  const { id: workspaceId, journeyId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Journey definition
  const { data: journey } = await admin
    .from("journey_definitions")
    .select("*")
    .eq("id", journeyId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!journey) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Session counts by status
  const { data: sessions } = await admin
    .from("journey_sessions")
    .select("status, outcome, current_step")
    .eq("journey_id", journeyId);

  const statusCounts: Record<string, number> = { pending: 0, in_progress: 0, completed: 0, expired: 0, abandoned: 0 };
  const outcomeCounts: Record<string, number> = {};

  for (const s of sessions || []) {
    statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
    if (s.outcome) {
      outcomeCounts[s.outcome] = (outcomeCounts[s.outcome] || 0) + 1;
    }
  }

  const stats = {
    total: sessions?.length || 0,
    ...statusCounts,
    outcomes: outcomeCounts,
    reasons: {} as Record<string, number>,
  };

  // Top cancellation reasons from step events
  const { data: reasonEvents } = await admin
    .from("journey_step_events")
    .select("response_value, response_label")
    .eq("step_key", "cancellation_reason")
    .in("session_id", (sessions || []).map((s) => s.status).length > 0
      ? (await admin.from("journey_sessions").select("id").eq("journey_id", journeyId)).data?.map((s) => s.id) || []
      : []
    );

  for (const e of reasonEvents || []) {
    stats.reasons[e.response_label] = (stats.reasons[e.response_label] || 0) + 1;
  }

  return NextResponse.json({ journey, stats });
}
