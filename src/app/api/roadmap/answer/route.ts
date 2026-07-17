/**
 * POST /api/roadmap/answer — owner answers a build's open questions.
 *   { jobId, answers: [{ id, q, answer }] }
 * Writes answers + flips the job to queued_resume; the box worker picks it up and
 * resumes the same claude session (claude --resume). See roadmap-build-console.md (Phase 5).
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { answerRoadmapBuild } from "@/lib/roadmap-actions";

export async function POST(request: Request) {
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const body = (await request.json().catch(() => ({}))) as { jobId?: unknown; answers?: unknown };

  const result = await answerRoadmapBuild(workspaceId, user.id, {
    jobId: typeof body.jobId === "string" ? body.jobId : "",
    answers: body.answers as { id: string; answer: string }[],
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ job: result.job });
}
