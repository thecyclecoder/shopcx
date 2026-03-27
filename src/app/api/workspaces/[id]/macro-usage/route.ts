import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// POST: Log a macro usage event
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { macro_id, ticket_id, message_id, source, outcome, ai_confidence } = body;

  if (!macro_id || !source || !outcome) {
    return NextResponse.json({ error: "macro_id, source, and outcome required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Log the usage event
  await admin.from("macro_usage_log").insert({
    workspace_id: workspaceId,
    macro_id,
    ticket_id: ticket_id || null,
    message_id: message_id || null,
    user_id: user.id,
    source,
    outcome,
    ai_confidence: ai_confidence || null,
  });

  // Record suggestion outcome for tracking
  if (source === "ai_suggested") {
    const outcomeMap: Record<string, string> = {
      applied: "accepted",
      personalized: "accepted",
      edited: "edited",
      rejected: "rejected",
    };
    const trackOutcome = outcomeMap[outcome];
    if (trackOutcome) {
      await admin.rpc("record_macro_suggestion_outcome", {
        p_macro_id: macro_id,
        p_outcome: trackOutcome,
      });
    }
  }

  return NextResponse.json({ ok: true });
}

// GET: Macro usage analytics
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

  // Get macros with suggestion stats
  const { data: macros } = await admin
    .from("macros")
    .select("id, name, category, usage_count, ai_suggest_count, ai_accept_count, ai_reject_count, ai_edit_count, last_suggested_at")
    .eq("workspace_id", workspaceId)
    .eq("active", true)
    .order("usage_count", { ascending: false })
    .limit(50);

  // Recent usage log
  const { data: recentUsage } = await admin
    .from("macro_usage_log")
    .select("id, macro_id, ticket_id, source, outcome, ai_confidence, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(100);

  return NextResponse.json({
    macros: macros || [],
    recent_usage: recentUsage || [],
  });
}
