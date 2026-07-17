/**
 * GET /api/tickets/triage-status — is a box escalation triage review in-flight for this workspace?
 *
 * The hourly triage-escalations-cron enqueues one agent_jobs row per eligible escalated ticket. Phase 1
 * of june-review-replaces-solver-skeptic-quorum-triage swapped the enqueue kind: it now enqueues
 * `cs-director-call` (June's review — the primary triage) per ticket instead of the legacy per-
 * workspace `triage-escalations` sweep job. This route considers BOTH kinds so the badge still fires
 * during rollout AND after: while any such job is in an active state, the AiInvestigationBadge appends
 * "· triage in progress" so a human agent knows the routine is actively reviewing the escalated queue
 * right now. See docs/brain/specs/ai-investigation-ticket-visibility.md +
 * docs/brain/specs/june-review-replaces-solver-skeptic-quorum-triage.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Active (not terminal) agent_jobs statuses — mirrors docs/brain/tables/agent_jobs.md.
const ACTIVE_JOB_STATUSES = [
  "queued",
  "claimed",
  "building",
  "needs_input",
  "needs_approval",
  "queued_resume",
];

export async function GET() {
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ in_progress: false });

  const admin = createAdminClient();
  const { count } = await admin
    .from("agent_jobs")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .in("kind", ["cs-director-call", "triage-escalations"])
    .in("status", ACTIVE_JOB_STATUSES);

  return NextResponse.json({ in_progress: (count || 0) > 0 });
}
