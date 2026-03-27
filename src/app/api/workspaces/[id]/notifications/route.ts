import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET: List notifications for current user (unread first, recent)
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: notifications } = await admin
    .from("dashboard_notifications")
    .select("*")
    .eq("workspace_id", workspaceId)
    .or(`user_id.is.null,user_id.eq.${user.id}`)
    .eq("dismissed", false)
    .order("read", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(50);

  // Count unread
  const { count } = await admin
    .from("dashboard_notifications")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .or(`user_id.is.null,user_id.eq.${user.id}`)
    .eq("read", false)
    .eq("dismissed", false);

  return NextResponse.json({
    notifications: notifications || [],
    unread_count: count || 0,
  });
}

// PATCH: Mark all as read, or mark all as dismissed
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const admin = createAdminClient();

  if (body.action === "read_all") {
    await admin
      .from("dashboard_notifications")
      .update({ read: true })
      .eq("workspace_id", workspaceId)
      .or(`user_id.is.null,user_id.eq.${user.id}`)
      .eq("read", false);
  }

  return NextResponse.json({ ok: true });
}
