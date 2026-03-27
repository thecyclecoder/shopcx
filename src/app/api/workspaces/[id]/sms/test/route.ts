import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendSMS } from "@/lib/twilio";

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
  const { to } = body;

  if (!to) {
    return NextResponse.json({ error: "Phone number required" }, { status: 400 });
  }

  const result = await sendSMS(workspaceId, to, "This is a test SMS from ShopCX. Your SMS integration is working!");

  if (result.success) {
    return NextResponse.json({ success: true, messageSid: result.messageSid });
  } else {
    return NextResponse.json({ success: false, error: result.error }, { status: 400 });
  }
}
