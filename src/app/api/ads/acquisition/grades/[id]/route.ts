/**
 * Acquisition Research Hub — the Growth-director override of a gap→outcome grade
 * (docs/brain/specs/acquisition-research-loop-grading.md, Phase 1; M5 of the Acquisition Research
 * Engine). The human-overridable gate (mirror of the storefront-campaign-grade override): records
 * graded_by='human' + overridden_by so the override is NEVER silently lost, and optionally drafts an
 * acquisition_grader_prompts calibration rule (Opus) the director can approve. OWNER-ONLY.
 *
 * Body: { workspaceId, grade: 1-10, reason, axis?: 'initial'|'revised', propose_rule?: boolean }
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { OPUS_MODEL } from "@/lib/ai-models";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: gradeId } = await params;
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const workspaceId: string | null = body.workspaceId ?? null;
  const grade = Number(body.grade);
  const reason = String(body.reason || "").trim();
  const axis: "initial" | "revised" = body.axis === "revised" ? "revised" : "initial";
  const proposeRule = !!body.propose_rule;

  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  if (!Number.isInteger(grade) || grade < 1 || grade > 10)
    return NextResponse.json({ error: "grade_must_be_1_to_10" }, { status: 400 });
  if (!reason) return NextResponse.json({ error: "reason_required" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || member.role !== "owner") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data: existing } = await admin
    .from("acquisition_gap_grades")
    .select("id, gap_source, gap_id, grade_initial, grade_revised, gap_type")
    .eq("id", gradeId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!existing) return NextResponse.json({ error: "grade_not_found" }, { status: 404 });

  const now = new Date().toISOString();
  // Override the chosen axis; the other grade is left untouched — both grades always persist.
  const update: Record<string, unknown> = {
    graded_by: "human",
    overridden_by: user.id,
    override_reason: reason,
    overridden_at: now,
    updated_at: now,
  };
  if (axis === "revised") {
    update.grade_revised = grade;
    update.grade_revised_reasoning = `[Growth override] ${reason}`;
  } else {
    update.grade_initial = grade;
    update.grade_initial_reasoning = `[Growth override] ${reason}`;
  }
  await admin.from("acquisition_gap_grades").update(update).eq("id", gradeId);

  let proposedRuleId: string | null = null;
  if (proposeRule && process.env.ANTHROPIC_API_KEY) {
    try {
      const priorGrade = axis === "revised" ? existing.grade_revised : existing.grade_initial;
      const prompt = `An acquisition-research scout's "${existing.gap_type}" competitive gap was graded by an AI grader. The grader's ${axis} grade was ${priorGrade ?? "n/a"}/10. The Head of Growth OVERRODE it to ${grade}/10. Their reasoning:
"${reason}"

Propose a SHORT calibration rule to add to the gap grader's system prompt so it grades similar future gaps the way the director intends. The rule should be:
  • One concrete sentence describing the pattern
  • Actionable for a grader scoring gap_quality and outcome_quality 1-10 (gap quality is judged SEPARATELY from outcome — a well-evidenced gap that lost is still good scouting)
  • General enough to apply to similar gaps

Output JSON:
{
  "title": "<3-7 word title>",
  "content": "<the rule itself, 1-3 sentences>"
}`;
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
              .from("acquisition_grader_prompts")
              .insert({
                workspace_id: workspaceId,
                title: parsed.title,
                content: parsed.content,
                status: "proposed",
                derived_from_gap_source: existing.gap_source,
                derived_from_gap_id: existing.gap_id,
                derived_from_grade_id: gradeId,
              })
              .select("id")
              .single();
            proposedRuleId = inserted?.id || null;
          }
        }
      }
    } catch (err) {
      console.error("[acquisition-gap-grade override] rule proposal failed:", err);
    }
  }

  return NextResponse.json({ ok: true, grade_id: gradeId, axis, proposed_rule_id: proposedRuleId });
}
