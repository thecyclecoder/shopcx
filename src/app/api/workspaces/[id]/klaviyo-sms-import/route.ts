/**
 * Trigger a Klaviyo SMS campaign history import for the workspace.
 * Fire-and-forget — kicks off the Inngest function which does the
 * paginated pull + per-campaign upsert. UI polls the table for
 * results.
 *
 * Body: { history_days?: number }   (default 200 days ≈ 6 months)
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

  // Confirm Klaviyo is configured before starting.
  const { data: ws } = await admin.from("workspaces")
    .select("klaviyo_api_key_encrypted").eq("id", workspaceId).single();
  if (!ws?.klaviyo_api_key_encrypted) {
    return NextResponse.json(
      { error: "Klaviyo API key not configured for this workspace" },
      { status: 400 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const historyDays = Number(body?.history_days) || 200;

  await inngest.send({
    name: "marketing/klaviyo-sms.import",
    data: { workspace_id: workspaceId, history_days: historyDays },
  });

  return NextResponse.json({ ok: true, history_days: historyDays });
}
