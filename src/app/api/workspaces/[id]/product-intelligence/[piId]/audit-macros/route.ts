import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

// POST: Start a macro audit job (async via Inngest)
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; piId: string }> }
) {
  const { id: workspaceId, piId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Create job record
  const { data: job, error } = await admin.from("macro_audit_jobs").insert({
    workspace_id: workspaceId,
    product_intelligence_id: piId,
    status: "pending",
  }).select("id").single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Fire Inngest event
  await inngest.send({
    name: "macro-audit/start",
    data: { workspace_id: workspaceId, job_id: job.id, product_intelligence_id: piId },
  });

  return NextResponse.json({ job_id: job.id });
}

// GET: Poll job progress
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; piId: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const jobId = request.nextUrl.searchParams.get("job_id");
  if (!jobId) return NextResponse.json({ error: "job_id required" }, { status: 400 });

  const admin = createAdminClient();
  const { data } = await admin.from("macro_audit_jobs")
    .select("id, status, total, completed, results, error")
    .eq("id", jobId).eq("workspace_id", workspaceId).single();

  if (!data) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  return NextResponse.json(data);
}

// PATCH: Apply approved rewrites
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; piId: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const body = await request.json();
  const { updates } = body as { updates: { macro_id: string; body_text: string; body_html?: string }[] };

  if (!updates?.length) return NextResponse.json({ error: "No updates" }, { status: 400 });

  let applied = 0;
  for (const u of updates) {
    const updateData: Record<string, unknown> = { body_text: u.body_text, updated_at: new Date().toISOString() };
    if (u.body_html) updateData.body_html = u.body_html;
    const { error } = await admin.from("macros").update(updateData).eq("id", u.macro_id).eq("workspace_id", workspaceId);
    if (!error) applied++;
  }

  return NextResponse.json({ ok: true, applied });
}
