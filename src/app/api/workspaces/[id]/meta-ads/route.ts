import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { getMetaAdsLoginUrl, getMetaAccountId, metaGraphRequest } from "@/lib/meta/api";
import { inngest } from "@/lib/inngest/client";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  // Get connection status
  const { data: conn } = await admin
    .from("meta_connections")
    .select("id, meta_user_name, is_active, access_token_encrypted, created_at")
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (action === "login-url") {
    return NextResponse.json({ url: getMetaAdsLoginUrl(workspaceId) });
  }

  if (action === "accounts") {
    // Fetch available ad accounts from Meta
    if (!conn?.access_token_encrypted) {
      return NextResponse.json({ error: "Not connected" }, { status: 400 });
    }

    const token = decrypt(conn.access_token_encrypted);
    const data = await metaGraphRequest(token, "/me/adaccounts", {
      fields: "id,name,account_status,currency,timezone_name",
      limit: "50",
    }) as { data: Array<{ id: string; name: string; account_status: number; currency: string; timezone_name: string }> };

    // Only active accounts
    const accounts = (data.data || [])
      .filter(a => a.account_status === 1)
      .map(a => ({
        id: a.id.replace("act_", ""),
        name: a.name,
        currency: a.currency,
        timezone: a.timezone_name,
      }));

    // Get already-saved accounts
    const { data: saved } = await admin
      .from("meta_ad_accounts")
      .select("meta_account_id, is_active")
      .eq("workspace_id", workspaceId);

    const savedIds = new Set((saved || []).filter(s => s.is_active).map(s => s.meta_account_id));

    return NextResponse.json({
      accounts,
      selected: [...savedIds],
    });
  }

  // Default: return connection + saved accounts
  const { data: savedAccounts } = await admin
    .from("meta_ad_accounts")
    .select("id, meta_account_id, meta_account_name, is_active, last_sync_at")
    .eq("workspace_id", workspaceId);

  return NextResponse.json({
    connected: !!conn?.is_active,
    user_name: conn?.meta_user_name || null,
    accounts: savedAccounts || [],
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { action } = body;
  const admin = createAdminClient();

  if (action === "save-accounts") {
    // Save selected ad accounts
    const accounts = body.accounts as Array<{ id: string; name: string; currency: string; timezone: string }>;
    const selectedIds = new Set(accounts.map(a => a.id));

    const { data: conn } = await admin
      .from("meta_connections")
      .select("id")
      .eq("workspace_id", workspaceId)
      .single();

    if (!conn) return NextResponse.json({ error: "Not connected" }, { status: 400 });

    // Upsert selected accounts
    for (const account of accounts) {
      await admin.from("meta_ad_accounts").upsert({
        workspace_id: workspaceId,
        meta_connection_id: conn.id,
        meta_account_id: account.id,
        meta_account_name: account.name,
        currency: account.currency || "USD",
        timezone: account.timezone || "America/Chicago",
        is_active: true,
      }, { onConflict: "workspace_id,meta_account_id" });
    }

    // Deactivate unselected
    const { data: allAccounts } = await admin
      .from("meta_ad_accounts")
      .select("id, meta_account_id")
      .eq("workspace_id", workspaceId);

    for (const acct of allAccounts || []) {
      if (!selectedIds.has(acct.meta_account_id)) {
        await admin.from("meta_ad_accounts")
          .update({ is_active: false })
          .eq("id", acct.id);
      }
    }

    return NextResponse.json({ ok: true, saved: accounts.length });
  }

  if (action === "sync") {
    const days = body.days || 30;

    // Get active ad accounts
    const { data: accounts } = await admin
      .from("meta_ad_accounts")
      .select("id, meta_account_id")
      .eq("workspace_id", workspaceId)
      .eq("is_active", true);

    if (!accounts?.length) return NextResponse.json({ error: "No active ad accounts" }, { status: 400 });

    for (const acct of accounts) {
      await inngest.send({
        name: "meta/sync-spend",
        data: {
          workspace_id: workspaceId,
          ad_account_id: acct.id,
          meta_account_id: acct.meta_account_id,
          days,
        },
      });
    }

    return NextResponse.json({ ok: true, message: `Sync triggered for ${accounts.length} accounts (${days} days)` });
  }

  if (action === "disconnect") {
    await admin.from("meta_connections")
      .update({ is_active: false })
      .eq("workspace_id", workspaceId);

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
