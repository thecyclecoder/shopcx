import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

/**
 * POST: kick off a reseller-discovery run for this workspace.
 * Dispatches via Inngest (the run takes 1-3 minutes — too long for a
 * synchronous response). The UI can poll the resellers list to see
 * new entries appear, or watch for the dashboard notification.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await inngest.send({
    name: "resellers/discover.run",
    data: { workspaceId },
  });

  return NextResponse.json({ ok: true, dispatched: true });
}
