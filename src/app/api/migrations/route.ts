/**
 * GET /api/migrations — Appstle→internal migration audits for the dashboard
 * monitor. Returns status counts + the failed/pending rows (renewals at risk)
 * with their failing checks, plus recent passed ones for context.
 *
 * See docs/brain/specs/appstle-pricing-heal-and-migration-monitor.md § Phase 3.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET() {
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();

  const { data: rows } = await admin
    .from("migration_audits")
    .select("id, subscription_id, appstle_contract_id, internal_contract_id, is_recovery, status, checks, retry_count, last_error, created_at, updated_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(300);

  const all = rows || [];
  const counts = {
    passed: all.filter((r) => r.status === "passed").length,
    pending: all.filter((r) => r.status === "pending").length,
    failed: all.filter((r) => r.status === "failed").length,
    total: all.length,
  };
  // Surface the at-risk ones first (failed, then pending), then recent passed.
  const atRisk = all.filter((r) => r.status === "failed" || r.status === "pending");
  const recentPassed = all.filter((r) => r.status === "passed").slice(0, 25);

  // Attach the migration-fix box agent's diagnosis + proposed gated fix (if any) to each at-risk audit,
  // so a `failed` row surfaces WITH the box's written diagnosis (and Approve/Decline when it proposed a
  // fix). The job is keyed by spec_slug = the audit id. See docs/brain/specs/migration-fix-agent.md.
  const atRiskIds = atRisk.map((r) => r.id);
  if (atRiskIds.length) {
    const { data: fixJobs } = await admin
      .from("agent_jobs")
      .select("id, spec_slug, status, pending_actions, questions, log_tail, error, updated_at")
      .eq("workspace_id", workspaceId)
      .eq("kind", "migration-fix")
      .in("spec_slug", atRiskIds)
      .order("created_at", { ascending: false })
      .limit(300);
    type FixJobRow = { id: string; spec_slug: string; status: string; pending_actions: unknown; questions: unknown; log_tail: string | null; error: string | null; updated_at: string };
    const latestByAudit: Record<string, FixJobRow> = {};
    for (const j of (fixJobs || []) as FixJobRow[]) {
      if (!latestByAudit[j.spec_slug]) latestByAudit[j.spec_slug] = j; // newest wins (ordered desc)
    }
    for (const r of atRisk as Array<Record<string, unknown>>) {
      const j = latestByAudit[r.id as string];
      if (!j) continue;
      const actions = Array.isArray(j.pending_actions)
        ? (j.pending_actions as Array<Record<string, unknown>>).filter((a) => a.type === "migration_fix")
        : [];
      // For a human-JUDGMENT pause (needs_input) the box parked ONE plain question on the job; surface it
      // so the panel can render the prompt + an inline answer box (→ POST /api/roadmap/answer). See
      // docs/brain/specs/migration-fix-human-input.md.
      const questions = Array.isArray(j.questions)
        ? (j.questions as Array<Record<string, unknown>>).map((q) => ({ id: String(q.id ?? ""), q: String(q.q ?? "") }))
        : [];
      r.fix = {
        jobId: j.id,
        status: j.status, // queued|building|needs_input|needs_approval|completed|failed|needs_attention
        diagnosis: j.log_tail || null,
        error: j.error || null,
        questions,
        actions: actions.map((a) => ({ id: a.id, fix_kind: a.fix_kind, summary: a.summary, preview: a.preview, status: a.status, result: a.result })),
      };
    }
  }

  return NextResponse.json({ counts, atRisk, recentPassed });
}
