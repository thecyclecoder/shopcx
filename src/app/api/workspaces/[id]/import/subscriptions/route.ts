import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

// POST: kick off subscription import via Inngest
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
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

  const body = await request.json();
  const { file_path } = body;

  if (!file_path) {
    return NextResponse.json({ error: "file_path required" }, { status: 400 });
  }

  // Create a sync job to track progress
  const { data: job, error: jobError } = await admin
    .from("sync_jobs")
    .insert({
      workspace_id: workspaceId,
      type: "full",
      status: "pending",
      phase: "customers",
    })
    .select()
    .single();

  if (jobError || !job) {
    return NextResponse.json({ error: "Failed to create job" }, { status: 500 });
  }

  // Fire Inngest event
  await inngest.send({
    name: "import/subscriptions",
    data: { workspace_id: workspaceId, job_id: job.id, file_path },
  });

  return NextResponse.json({ job_id: job.id }, { status: 202 });
}
