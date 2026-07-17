/**
 * POST /api/developer/agents/grades/{gradeId} — the CEO overrides a director-decision grade
 * (director-loop-grading spec, Phase 4 — the human-overridable gate).
 *
 * Owner-gated. Records graded_by='human' + overridden_by so the override is NEVER silently lost
 * (the grader will never re-write a human grade), and — when the override moves the grade by ≥
 * OVERRIDE_GAP_RULE_THRESHOLD points (or propose_rule is explicitly requested) — drafts a
 * director_grader_prompts calibration rule (status='proposed', Opus) the CEO can approve so the
 * grader scores similar future calls the way the CEO intends. Mirrors the storefront campaign-grade
 * override route, one level up the org chart.
 *
 * Body: { grade: number(1-10), reason: string, propose_rule?: boolean }
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { OPUS_MODEL } from "@/lib/ai-models";
import { OVERRIDE_GAP_RULE_THRESHOLD } from "@/lib/agents/director-leash-recommendations";

export async function POST(request: Request, { params }: { params: Promise<{ gradeId: string }> }) {
  const { gradeId } = await params;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can override a director grade" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const grade = Number(body?.grade);
  const reason = String(body?.reason || "").trim();
  const proposeRuleRequested = !!body?.propose_rule;

  if (!Number.isInteger(grade) || grade < 1 || grade > 10) {
    return NextResponse.json({ error: "grade_must_be_1_to_10" }, { status: 400 });
  }
  if (!reason) return NextResponse.json({ error: "reason_required" }, { status: 400 });

  const { data: existing } = await admin
    .from("director_decision_grades")
    .select("id, dimension, grade, approval_decision_id")
    .eq("id", gradeId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!existing) return NextResponse.json({ error: "grade_not_found" }, { status: 404 });

  const priorGrade = typeof existing.grade === "number" ? (existing.grade as number) : null;
  const now = new Date().toISOString();
  await admin
    .from("director_decision_grades")
    .update({
      grade,
      reasoning: `[CEO override] ${reason}`,
      graded_by: "human",
      overridden_by: user.id,
      override_reason: reason,
      overridden_at: now,
      updated_at: now,
    })
    .eq("id", gradeId)
    .eq("workspace_id", workspaceId);

  // A large grade gap (or an explicit request) is a calibration signal → propose a director_grader_prompts
  // rule the CEO can approve. Only an APPROVED rule ever reaches the grader's prompt.
  const gap = priorGrade != null ? Math.abs(priorGrade - grade) : OVERRIDE_GAP_RULE_THRESHOLD;
  let proposedRuleId: string | null = null;
  if ((proposeRuleRequested || gap >= OVERRIDE_GAP_RULE_THRESHOLD) && process.env.ANTHROPIC_API_KEY) {
    try {
      const prompt = `The CEO of ShopCX supervises an autonomous Platform/DevOps Director. An AI grader scored one of the director's ${existing.dimension} calls ${priorGrade ?? "n/a"}/10. The CEO OVERRODE it to ${grade}/10. Their reasoning:
"${reason}"

Propose a SHORT calibration rule to add to the director-grader's system prompt so it grades similar future ${existing.dimension} calls the way the CEO intends. The rule should be:
  • One concrete pattern the grader should recognize (remember: SOUNDNESS at decision time is scored separately from OUTCOME — a sound call that hit a rare reversible bump still grades high).
  • Actionable for a grader scoring a director call 1-10.
  • General enough to apply to similar calls.

Output JSON only:
{ "title": "<3-7 word title>", "content": "<the rule itself, 1-3 sentences>" }`;
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: OPUS_MODEL, max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = (data.content?.[0] as { text?: string })?.text?.trim() || "";
        const m = text.match(/\{[\s\S]*\}/);
        if (m) {
          const parsed = JSON.parse(m[0]) as { title?: string; content?: string };
          if (parsed.title && parsed.content) {
            const { data: inserted } = await admin
              .from("director_grader_prompts")
              .insert({
                workspace_id: workspaceId,
                title: parsed.title,
                content: parsed.content,
                status: "proposed",
                derived_from_decision_id: existing.approval_decision_id ?? null,
                derived_from_grade_id: gradeId,
              })
              .select("id")
              .single();
            proposedRuleId = inserted?.id || null;
          }
        }
      }
    } catch (err) {
      console.error("[director-grade override] rule proposal failed:", err);
    }
  }

  return NextResponse.json({ ok: true, grade_id: gradeId, grade, proposed_rule_id: proposedRuleId });
}
