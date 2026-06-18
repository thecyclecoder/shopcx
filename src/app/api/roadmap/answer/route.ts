/**
 * POST /api/roadmap/answer — owner answers a build's open questions.
 *   { jobId, answers: [{ id, q, answer }] }
 * Writes answers + flips the job to queued_resume; the box worker picks it up and
 * resumes the same claude session (claude --resume). See roadmap-build-console.md (Phase 5).
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentJob } from "@/lib/agent-jobs";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
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
    return NextResponse.json({ error: "Only the workspace owner can answer a build" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { jobId?: unknown; answers?: unknown };
  if (typeof body.jobId !== "string" || !Array.isArray(body.answers)) {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }

  const { data: job } = await admin
    .from("agent_jobs")
    .select("*")
    .eq("id", body.jobId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
  if ((job as AgentJob).status !== "needs_input") {
    return NextResponse.json({ error: "job is not awaiting input" }, { status: 409 });
  }

  const { data: updated, error } = await admin
    .from("agent_jobs")
    .update({ answers: body.answers, status: "queued_resume", updated_at: new Date().toISOString() })
    .eq("id", body.jobId)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ job: updated as AgentJob });
}
