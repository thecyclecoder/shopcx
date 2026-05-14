/**
 * Trigger Klaviyo engagement backfill — pulls 180d of Clicked SMS,
 * Opened Email, Clicked Email, Viewed Product, Added to Cart,
 * Checkout Started, and Active on Site events. Fire-and-forget.
 *
 * Body: { days?: number }   default 180
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin", "marketing"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: ws } = await admin.from("workspaces")
    .select("klaviyo_api_key_encrypted").eq("id", workspaceId).single();
  if (!ws?.klaviyo_api_key_encrypted) {
    return NextResponse.json(
      { error: "Klaviyo API key not configured for this workspace" },
      { status: 400 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const days = Number(body?.days) || 180;

  await inngest.send({
    name: "marketing/klaviyo-engagement.backfill",
    data: { workspace_id: workspaceId, days },
  });

  return NextResponse.json({ ok: true, days });
}
