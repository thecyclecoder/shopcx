import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

// GET: Poll import job status
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> }
) {
  const { id: workspaceId, jobId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: job } = await admin
    .from("import_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  return NextResponse.json(job);
}

// POST: Resume a failed import job
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> }
) {
  const { id: workspaceId, jobId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: job } = await admin
    .from("import_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.status !== "failed") {
    return NextResponse.json({ error: "Can only resume failed jobs" }, { status: 400 });
  }

  // Reset job status
  await admin.from("import_jobs").update({
    status: "processing",
    error: null,
    completed_at: null,
  }).eq("id", jobId);

  // Determine where to resume based on what phase failed
  if (job.completed_chunks < job.total_chunks) {
    // Resume from failed chunk — re-fire remaining chunk.process events
    const basePath = job.file_path.replace(".csv", "");
    const events = [];
    for (let i = job.completed_chunks; i < job.total_chunks; i++) {
      events.push({
        name: "import/chunk.process" as const,
        data: {
          workspace_id: workspaceId,
          job_id: jobId,
          chunk_index: i,
          chunk_path: `${basePath}-chunk-${i}.csv`,
        },
      });
    }
    if (events.length > 0) {
      await inngest.send(events);
    }
  } else if (job.finalize_completed < job.finalize_total) {
    // Resume finalize — re-fire chunks.complete to recalculate batches
    await admin.from("import_jobs").update({ status: "finalizing" }).eq("id", jobId);
    await inngest.send({
      name: "import/chunks.complete",
      data: { workspace_id: workspaceId, job_id: jobId },
    });
  } else {
    // Just re-fire job.complete
    await inngest.send({
      name: "import/job.complete",
      data: { workspace_id: workspaceId, job_id: jobId },
    });
  }

  return NextResponse.json({ resumed: true });
}
