/**
 * GET   — list this workspace's discovered Meta ad accounts (auto-populated
 *         at OAuth connect time, can also be refreshed manually).
 * PATCH — { fb_act_id, sync_enabled } toggle a single account.
 * POST  — { action: "refresh" } re-pull /me/adaccounts from Meta and upsert.
 *         { action: "sync_now" } fire the historical-comments backfill.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { inngest } from "@/lib/inngest/client";

const GRAPH = "https://graph.facebook.com/v21.0";

export async function GET(
  _req: Request,
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
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data } = await admin
    .from("meta_ad_accounts")
    .select("id, fb_act_id, name, account_status, sync_enabled, last_synced_at")
    .eq("workspace_id", workspaceId)
    .order("account_status", { ascending: true })   // active (1) first
    .order("name", { ascending: true });
  return NextResponse.json({ accounts: data || [] });
}

export async function PATCH(
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
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { fb_act_id, sync_enabled } = await request.json();
  if (typeof fb_act_id !== "string" || typeof sync_enabled !== "boolean") {
    return NextResponse.json({ error: "fb_act_id (string) + sync_enabled (boolean) required" }, { status: 400 });
  }

  const { error } = await admin
    .from("meta_ad_accounts")
    .update({ sync_enabled, updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("fb_act_id", fb_act_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

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
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { action, days } = await request.json().catch(() => ({}));

  if (action === "refresh") {
    const { data: ws } = await admin
      .from("workspaces")
      .select("meta_user_access_token_encrypted")
      .eq("id", workspaceId)
      .single();
    if (!ws?.meta_user_access_token_encrypted) {
      return NextResponse.json({ error: "Meta not connected" }, { status: 400 });
    }
    const token = decrypt(ws.meta_user_access_token_encrypted as string);
    const r = await fetch(`${GRAPH}/me/adaccounts?fields=id,name,account_status&limit=200&access_token=${encodeURIComponent(token)}`);
    if (!r.ok) return NextResponse.json({ error: `Meta API ${r.status}` }, { status: 500 });
    const accts = ((await r.json()).data || []) as Array<{ id: string; name: string; account_status: number }>;
    const now = new Date().toISOString();
    for (const a of accts) {
      await admin.from("meta_ad_accounts").upsert(
        { workspace_id: workspaceId, fb_act_id: a.id, name: a.name, account_status: a.account_status, updated_at: now },
        { onConflict: "workspace_id,fb_act_id" },
      );
    }
    return NextResponse.json({ ok: true, count: accts.length });
  }

  if (action === "sync_now") {
    await inngest.send({
      name: "meta/historical-comments.sync",
      data: { workspace_id: workspaceId, days: Number(days) || 30 },
    });
    return NextResponse.json({ ok: true, queued: true });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
