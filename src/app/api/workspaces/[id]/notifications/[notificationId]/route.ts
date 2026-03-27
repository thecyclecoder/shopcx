import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// PATCH: Mark single notification as read or dismissed
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; notificationId: string }> }
) {
  const { id: workspaceId, notificationId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const admin = createAdminClient();

  const updates: Record<string, boolean> = {};
  if (body.read !== undefined) updates.read = !!body.read;
  if (body.dismissed !== undefined) updates.dismissed = !!body.dismissed;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  await admin
    .from("dashboard_notifications")
    .update(updates)
    .eq("id", notificationId)
    .eq("workspace_id", workspaceId);

  return NextResponse.json({ ok: true });
}
