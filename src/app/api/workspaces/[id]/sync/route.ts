import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

// POST: kick off a background sync via Inngest
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  void request;

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

  // Check if there's already a running sync
  const { data: existingJob } = await admin
    .from("sync_jobs")
    .select("id, status")
    .eq("workspace_id", workspaceId)
    .in("status", ["pending", "running"])
    .limit(1)
    .single();

  if (existingJob) {
    return NextResponse.json(
      { error: "A sync is already in progress", job_id: existingJob.id },
      { status: 409 }
    );
  }

  // Create sync job record
  const { data: job, error: jobError } = await admin
    .from("sync_jobs")
    .insert({
      workspace_id: workspaceId,
      type: "full",
      status: "pending",
    })
    .select()
    .single();

  if (jobError || !job) {
    return NextResponse.json({ error: "Failed to create sync job" }, { status: 500 });
  }

  // Fire Inngest event
  await inngest.send({
    name: "shopify/sync.requested",
    data: {
      workspace_id: workspaceId,
      job_id: job.id,
    },
  });

  return NextResponse.json({ job_id: job.id }, { status: 202 });
}

// GET: poll sync job status
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get("job_id");

  const admin = createAdminClient();

  if (jobId) {
    // Get specific job
    const { data: job } = await admin
      .from("sync_jobs")
      .select("*")
      .eq("id", jobId)
      .eq("workspace_id", workspaceId)
      .single();

    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    return NextResponse.json(job);
  }

  // Get latest job for this workspace
  const { data: job } = await admin
    .from("sync_jobs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  return NextResponse.json(job || null);
}
