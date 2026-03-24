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

  let body: { type?: string; resume?: boolean } = {};
  try { body = await request.json(); } catch { /* empty body ok */ }
  const syncType = body.type === "orders" ? "orders" : body.type === "customers" ? "customers" : "full";

  // Check if there's already a running sync
  const { data: existingJob } = await admin
    .from("sync_jobs")
    .select("id, status, type")
    .eq("workspace_id", workspaceId)
    .in("status", ["pending", "running"])
    .limit(1)
    .single();

  if (existingJob) {
    return NextResponse.json(
      { error: `A ${existingJob.type} sync is already in progress`, job_id: existingJob.id },
      { status: 409 }
    );
  }

  // Check for a recent failed job to resume from
  let resumeCursor: string | null = null;
  let resumeSynced = 0;
  let resumeBatch = 0;
  if (body.resume) {
    const { data: lastFailed } = await admin
      .from("sync_jobs")
      .select("last_cursor, synced_customers, synced_orders, current_month, type")
      .eq("workspace_id", workspaceId)
      .eq("type", syncType)
      .eq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (lastFailed?.last_cursor) {
      resumeCursor = lastFailed.last_cursor;
      resumeSynced = syncType === "orders" ? (lastFailed.synced_orders || 0) : (lastFailed.synced_customers || 0);
      resumeBatch = lastFailed.current_month || 0;
    }
  }

  // Get total counts for the new job (so progress bar shows correctly from the start)
  let totalCustomers = 0;
  let totalOrders = 0;
  if (resumeSynced > 0) {
    // Pre-populate from the failed job's totals
    const { data: lastJob } = await admin
      .from("sync_jobs")
      .select("total_customers, total_orders")
      .eq("workspace_id", workspaceId)
      .eq("type", syncType)
      .eq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    totalCustomers = lastJob?.total_customers || 0;
    totalOrders = lastJob?.total_orders || 0;
  }

  // Create sync job
  const { data: job, error: jobError } = await admin
    .from("sync_jobs")
    .insert({
      workspace_id: workspaceId,
      type: syncType,
      status: "pending",
      last_cursor: resumeCursor,
      current_month: resumeBatch,
      synced_customers: syncType === "customers" ? resumeSynced : 0,
      synced_orders: syncType === "orders" ? resumeSynced : 0,
      total_customers: totalCustomers,
      total_orders: totalOrders,
    })
    .select()
    .single();

  if (jobError || !job) {
    return NextResponse.json({ error: "Failed to create sync job" }, { status: 500 });
  }

  // Fire appropriate Inngest event(s)
  if (syncType === "customers" || syncType === "full") {
    await inngest.send({
      name: "shopify/sync.customers",
      data: { workspace_id: workspaceId, job_id: job.id },
    });
  }

  if (syncType === "orders") {
    await inngest.send({
      name: "shopify/sync.orders",
      data: { workspace_id: workspaceId, job_id: job.id },
    });
  }

  // For "full", fire orders after customers complete (handled by separate button now)
  // Full sync just does customers — user clicks orders separately

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

  // Auto-fail stale jobs (running for more than 2 hours with no progress)
  const twoHoursAgo = new Date(Date.now() - 120 * 60 * 1000).toISOString();
  await admin
    .from("sync_jobs")
    .update({ status: "failed", error: "Timed out — no progress for 2 hours" })
    .eq("workspace_id", workspaceId)
    .in("status", ["pending", "running"])
    .lt("started_at", twoHoursAgo);

  if (jobId) {
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
