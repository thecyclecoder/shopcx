/**
 * GET /api/developer/agents/approval-detail?jobId={uuid} — the LIVE pending actions of one
 * needs_approval job, for the Agents-hub inbox's rich-approval modal (approval-routing-engine Phase 4).
 *
 * The inbox is the single QUEUE + ENTRY POINT (CEO ruling 2026-06-23): a SIMPLE approve/decline is
 * decided inline on the row; a RICH approval (multi-branch plan, multi-action build, the control-tower
 * repair / db_health / coverage-register proposals) opens a modal launched FROM the row that reuses the
 * existing action endpoints in-context — no navigation to a scattered standalone card. The modal reads
 * its action list HERE (live, not the notification snapshot) so a multi-action job whose branches are
 * decided one at a time always shows the still-pending ones.
 *
 * Owner-gated, read-only. The decision itself still posts to the unchanged executors
 * (POST /api/roadmap/approve for plan/build/migration-fix · the control-tower endpoints for
 * repair/db_health/coverage-register), so no approval can execute by a path that skips the gate.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface DetailAction {
  id: string;
  type: string;
  status: string;
  summary: string;
  preview: string | null;
  cmd: string | null;
  stage: string | null;
}

export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
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
    return NextResponse.json({ error: "Only the workspace owner can view an approval" }, { status: 403 });
  }

  const jobId = new URL(req.url).searchParams.get("jobId") || "";
  if (!jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });

  const { data: job } = await admin
    .from("agent_jobs")
    .select("id, kind, spec_slug, status, pending_actions")
    .eq("id", jobId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });

  const raw = Array.isArray(job.pending_actions) ? (job.pending_actions as Array<Record<string, unknown>>) : [];
  const actions: DetailAction[] = raw.map((a) => ({
    id: typeof a.id === "string" ? a.id : "",
    type: typeof a.type === "string" ? a.type : "",
    status: typeof a.status === "string" ? a.status : "pending",
    summary: typeof a.summary === "string" ? a.summary : "",
    preview: typeof a.preview === "string" ? a.preview : null,
    cmd: typeof a.cmd === "string" ? a.cmd : null,
    stage: typeof a.stage === "string" ? a.stage : null,
  }));

  return NextResponse.json({
    jobId: job.id as string,
    kind: job.kind as string,
    specSlug: (job.spec_slug as string | null) ?? null,
    status: job.status as string,
    actions,
  });
}
