/**
 * Manual override of an auto-decision on a sonnet_prompt.
 *
 *   POST /api/sonnet-prompts/{id}/override
 *   body: { action: 'accept' | 'reject' | 'revert' }
 *
 * Writes a NEW sonnet_prompt_decisions row with source='manual_override'
 * + performed_by=user.id, and updates the sonnet_prompts row to match.
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: promptId } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const action = body.action as "accept" | "reject" | "revert" | undefined;
  if (!["accept", "reject", "revert"].includes(action as string)) {
    return NextResponse.json({ error: "action must be accept/reject/revert" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: prompt, error: pErr } = await admin
    .from("sonnet_prompts")
    .select("id, workspace_id, status, auto_decision, auto_decision_confidence, title, content, category")
    .eq("id", promptId)
    .maybeSingle();
  if (pErr || !prompt) return NextResponse.json({ error: "Prompt not found" }, { status: 404 });

  // Membership check.
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", prompt.workspace_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    return NextResponse.json({ error: "Admin/owner only" }, { status: 403 });
  }

  // Resolve the final state.
  const reasoningPrefix = `[manual_override:${action}] by ${user.id}`;
  let finalDecision: "accept" | "reject" | "human_review";
  const updates: Record<string, any> = {
    auto_decision_at: new Date().toISOString(),
    auto_decision_model: "manual_override",
    auto_decision_reason: reasoningPrefix,
  };
  if (action === "revert") {
    // Move back to proposed; clear auto_decision.
    finalDecision = "human_review";
    updates.auto_decision = null;
    updates.status = "proposed";
    updates.reviewed_at = null;
    updates.enabled = true;
  } else if (action === "accept") {
    finalDecision = "accept";
    updates.auto_decision = "accept";
    updates.status = "approved";
    updates.reviewed_at = new Date().toISOString();
    updates.reviewed_by = user.id;
    updates.enabled = true;
  } else {
    finalDecision = "reject";
    updates.auto_decision = "reject";
    updates.status = "rejected";
    updates.reviewed_at = new Date().toISOString();
    updates.reviewed_by = user.id;
    updates.enabled = false;
  }

  // Audit row first (matches the cron's audit-first invariant).
  const auditDecisionForDb = action === "revert" ? "human_review" : finalDecision;
  const { error: auditErr } = await admin.from("sonnet_prompt_decisions").insert({
    workspace_id: prompt.workspace_id,
    sonnet_prompt_id: promptId,
    decision: auditDecisionForDb,
    confidence: 1.0, // human is authoritative
    reasoning: `${reasoningPrefix}. Previous auto_decision=${prompt.auto_decision ?? "null"} confidence=${prompt.auto_decision_confidence ?? "n/a"}.`,
    references_json: [],
    suggested_revisions: null,
    merge_target_id: null,
    supersede_target_id: null,
    input_proposal: { id: prompt.id, title: prompt.title, content: prompt.content, category: prompt.category },
    input_similar_prompts: [],
    input_policies: [],
    input_source_tickets: [],
    input_voice_doc_hashes: null,
    model: "manual_override",
    input_tokens: null,
    output_tokens: null,
    cost_usd_cents: 0,
    latency_ms: 0,
    source: "manual_override",
    performed_by: user.id,
  });
  if (auditErr) return NextResponse.json({ error: `audit failed: ${auditErr.message}` }, { status: 500 });

  const { error: updErr } = await admin
    .from("sonnet_prompts")
    .update(updates)
    .eq("id", promptId);
  if (updErr) return NextResponse.json({ error: `update failed: ${updErr.message}` }, { status: 500 });

  return NextResponse.json({ ok: true, action, prompt_id: promptId });
}
