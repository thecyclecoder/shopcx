/**
 * Auto-review decisions feed for /dashboard/ai-analysis Auto-decisions tab.
 *
 *   GET ?view=recent      → last 50 decisions across all prompts
 *   GET ?view=pending     → proposals where AI returned human_review,
 *                            sorted by confidence ascending (least-confident first)
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/supabase/server";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await ctx.params;
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const view = req.nextUrl.searchParams.get("view") || "recent";

  if (view === "pending") {
    const { data, error } = await admin
      .from("sonnet_prompts")
      .select(
        "id, title, content, category, proposed_at, auto_decision, auto_decision_at, auto_decision_reason, auto_decision_confidence, status",
      )
      .eq("workspace_id", workspaceId)
      .eq("auto_decision", "human_review")
      .eq("status", "proposed")
      .order("auto_decision_confidence", { ascending: true })
      .limit(100);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ pending: data || [] });
  }

  // Default: recent decisions.
  const { data, error } = await admin
    .from("sonnet_prompt_decisions")
    .select(
      "id, sonnet_prompt_id, decision, confidence, reasoning, references_json, suggested_revisions, merge_target_id, supersede_target_id, model, source, created_at",
    )
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Hydrate prompt titles + status for the table.
  const promptIds = Array.from(new Set((data || []).map((d) => d.sonnet_prompt_id)));
  const { data: prompts } = await admin
    .from("sonnet_prompts")
    .select("id, title, content, category, status, auto_decision, enabled")
    .in("id", promptIds);
  const promptById = new Map((prompts || []).map((p) => [p.id, p]));

  return NextResponse.json({
    decisions: (data || []).map((d) => ({
      ...d,
      prompt: promptById.get(d.sonnet_prompt_id) || null,
    })),
  });
}
