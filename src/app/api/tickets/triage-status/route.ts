/**
 * GET /api/tickets/triage-status — is a box escalation-triage sweep in-flight for this workspace?
 *
 * The hourly triage-escalations-cron enqueues one agent_jobs row (kind='triage-escalations') per
 * workspace per tick; the box claims it on its concurrency-1 lane and runs the solver→skeptic→quorum
 * sweep over routine-escalated tickets. While such a job is in an active state, the
 * AiInvestigationBadge appends "· triage in progress" so a human agent knows the routine is actively
 * working the escalated queue right now. See docs/brain/specs/ai-investigation-ticket-visibility.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
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
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ in_progress: false });

  const admin = createAdminClient();
  const { count } = await admin
    .from("agent_jobs")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("kind", "triage-escalations")
    .in("status", ACTIVE_JOB_STATUSES);

  return NextResponse.json({ in_progress: (count || 0) > 0 });
}
