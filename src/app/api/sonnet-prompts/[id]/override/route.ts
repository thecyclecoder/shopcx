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
import { getAuthedUser } from "@/lib/supabase/server";
import { applyManualOverride } from "@/lib/sonnet-prompts-table";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: promptId } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const rawAction = body.action as string | undefined;
  if (!rawAction || !["accept", "reject", "revert"].includes(rawAction)) {
    return NextResponse.json({ error: "action must be accept/reject/revert" }, { status: 400 });
  }
  const action = rawAction as "accept" | "reject" | "revert";

  const { user } = await getAuthedUser();
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

  // Audit row first (matches the cron's audit-first invariant). The audit ledger records the raw
  // human intent; the SDK write below applies the row shape.
  const reasoningPrefix = `[manual_override:${action}] by ${user.id}`;
  const auditDecisionForDb = action === "revert" ? "human_review" : action;
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

  // Route the prompt-row mutation through the sonnet-prompts SDK — the ONE writer that maps
  // accept / reject / revert onto the row shape (status + enabled + auto_decision* + reviewed_at
  // + reviewed_by). Compare-and-set on (id, workspace_id) so a stale click on a cross-workspace
  // id can never flip a foreign row. sonnet-prompts-sdk-for-review-agent-db-access Phase 1.
  const overrideRes = await applyManualOverride(admin, {
    workspaceId: prompt.workspace_id,
    promptId,
    action,
    actor: user.id,
    reasonPrefix: reasoningPrefix,
  });
  if (!overrideRes.ok) {
    return NextResponse.json({ error: `update failed: ${overrideRes.error ?? "unknown"}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true, action, prompt_id: promptId });
}
