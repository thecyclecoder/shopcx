import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { OPUS_MODEL } from "@/lib/ai-models";
import { applyAdminOverride, getLatestForTicket } from "@/lib/ticket-analyses-table";

// POST — admin overrides the auto score on the latest analysis.
// Optionally also drafts a grader_prompts rule via Opus that admin can
// approve in Settings → AI → Grader Rules.
//
// Body: { score: number, reason: string, propose_rule?: boolean }
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: ticketId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "no_workspace" }, { status: 400 });

  // Admin / owner only
  const admin = createAdminClient();
  const { data: member } = await admin.from("workspace_members")
    .select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const score = Number(body?.score);
  const reason = String(body?.reason || "").trim();
  const proposeRule = !!body?.propose_rule;

  if (!Number.isInteger(score) || score < 1 || score > 10) {
    return NextResponse.json({ error: "score_must_be_1_to_10" }, { status: 400 });
  }
  if (!reason) {
    return NextResponse.json({ error: "reason_required" }, { status: 400 });
  }

  // Find latest analysis for the ticket — via the ticket-analyses SDK (Phase 2 of ticket-
  // analyzer-becomes-box-agent-under-june). Scoped to the caller's workspace so a cross-
  // workspace ticket_id can never surface a foreign analysis.
  const latest = await getLatestForTicket(ticketId, {
    workspaceId,
    select: "id, score, issues, summary",
  });
  if (!latest) {
    return NextResponse.json({ error: "no_analysis_to_override" }, { status: 404 });
  }
  const latestId = latest.id as string;

  // Save override — SDK-owned write. applyAdminOverride does compare-and-set against
  // (analysis id, workspace_id) so an id from another workspace (the RLS shouldn't allow it,
  // but belt-and-braces) can never flip a foreign row.
  const overrideResult = await applyAdminOverride({
    analysisId: latestId,
    workspaceId,
    score,
    reason,
    correctedBy: user.id,
  });
  if (!overrideResult.ok) {
    return NextResponse.json({ error: overrideResult.error ?? "override_failed" }, { status: 500 });
  }

  let proposedRuleId: string | null = null;

  // If admin wants a rule proposed, ask Opus to draft one
  if (proposeRule && process.env.ANTHROPIC_API_KEY) {
    try {
      const issuesText = ((latest.issues as Array<{type?: string; description?: string}>) || [])
        .map(i => `${i.type}: ${i.description}`).join("\n");

      const prompt = `An AI quality analyst graded a customer-support ticket. The grader gave a score of ${latest.score}/10 with these issues:

${issuesText || "(no issues listed)"}

Summary: ${latest.summary || "(none)"}

The admin reviewed the ticket and OVERRODE the score to ${score}/10. Their reasoning:
"${reason}"

Propose a SHORT calibration rule that should be added to the grader's system prompt so it grades similar future tickets correctly. The rule should be:
  • One concrete sentence describing the pattern
  • Include the score-bound (e.g. "score X-Y" or "max score Z")
  • Specific enough to be actionable, general enough to apply to similar cases

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
        body: JSON.stringify({
          model: OPUS_MODEL,
          max_tokens: 400,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const text = (data.content?.[0] as { text?: string })?.text?.trim() || "";
        const m = text.match(/\{[\s\S]*\}/);
        if (m) {
          const parsed = JSON.parse(m[0]) as { title?: string; content?: string };
          if (parsed.title && parsed.content) {
            const { data: inserted } = await admin.from("grader_prompts").insert({
              workspace_id: workspaceId,
              title: parsed.title,
              content: parsed.content,
              status: "proposed",
              derived_from_ticket_id: ticketId,
              derived_from_analysis_id: latestId,
            }).select("id").single();
            proposedRuleId = inserted?.id || null;
          }
        }
      }
    } catch (err) {
      console.error("[override] rule proposal failed:", err);
    }
  }

  return NextResponse.json({
    ok: true,
    analysis_id: latestId,
    proposed_rule_id: proposedRuleId,
  });
}
