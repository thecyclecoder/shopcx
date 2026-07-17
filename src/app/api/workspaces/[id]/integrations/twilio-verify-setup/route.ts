/**
 * POST /api/workspaces/{id}/integrations/twilio-verify-setup
 *
 * One-click provisioner: creates a Twilio Verify Service (or returns
 * the existing SID if one is already attached) and stores it on
 * workspaces.twilio_verify_service_sid.
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createVerifyService } from "@/lib/twilio-verify";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  void request;
  const { id: workspaceId } = await params;
  const { user } = await getAuthedUser();
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

  const { data: ws } = await admin
    .from("workspaces")
    .select("name")
    .eq("id", workspaceId)
    .single();
  const friendlyName = `${ws?.name || "ShopCX"} Checkout OTP`;

  const result = await createVerifyService(workspaceId, friendlyName);
  if (!result.success) {
    return NextResponse.json({ error: result.error || "verify_setup_failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, sid: result.sid });
}
