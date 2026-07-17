/**
 * GET  — list this workspace's connected Meta ad accounts (managed by
 *        the ROAS Meta Ads integration via meta_connections +
 *        meta_ad_accounts). Read-only here; selection happens in the
 *        Meta Ads settings page.
 * POST — { action: "sync_now", days? } fire the historical-comments
 *        backfill across all active ad accounts.
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data } = await admin
    .from("meta_ad_accounts")
    .select("id, meta_account_id, meta_account_name, is_active, last_sync_at")
    .eq("workspace_id", workspaceId)
    .order("is_active", { ascending: false })
    .order("meta_account_name", { ascending: true });
  return NextResponse.json({ accounts: data || [] });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { action, days } = await request.json().catch(() => ({}));

  if (action === "sync_now") {
    await inngest.send({
      name: "meta/historical-comments.sync",
      data: { workspace_id: workspaceId, days: Number(days) || 30 },
    });
    return NextResponse.json({ ok: true, queued: true });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
