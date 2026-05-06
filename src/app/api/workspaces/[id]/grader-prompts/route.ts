import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET — list grader prompts (filtered by status)
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const status = req.nextUrl.searchParams.get("status"); // 'proposed' | 'approved' | 'rejected' | null (= all)

  const admin = createAdminClient();
  let q = admin.from("grader_prompts")
    .select("id, title, content, status, derived_from_ticket_id, derived_from_analysis_id, proposed_at, reviewed_at, sort_order, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  if (status) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ rules: data || [] });
}

// POST — create a new grader rule directly (admin-authored, not from a correction)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin.from("workspace_members")
    .select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const title = String(body?.title || "").trim();
  const content = String(body?.content || "").trim();
  const status = String(body?.status || "approved");
  const sortOrder = Number(body?.sort_order ?? 100);

  if (!title || !content) {
    return NextResponse.json({ error: "title_and_content_required" }, { status: 400 });
  }

  const { data, error } = await admin.from("grader_prompts").insert({
    workspace_id: workspaceId,
    title, content, status, sort_order: sortOrder,
    reviewed_at: status === "approved" ? new Date().toISOString() : null,
    reviewed_by: status === "approved" ? user.id : null,
  }).select().single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rule: data });
}
