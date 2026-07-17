/**
 * POST /api/workspaces/{id}/integrations/avalara/verify
 *
 * Tests the workspace's stored Avalara credentials (or a candidate set
 * passed in the body) by calling AvaTax's /utilities/ping endpoint.
 *   { ok: true, authenticated, environment }                 on success
 *   { ok: false, error: "<avalara message>" }                on failure
 *
 * Body shape (all optional — missing fields fall back to stored values
 * so the UI can verify a partially-edited form):
 *   { account_id?, license_key?, environment? }
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { pingAvalara } from "@/lib/avalara";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
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

  const body = (await request.json().catch(() => ({}))) as Partial<{
    account_id: string;
    license_key: string;
    environment: "sandbox" | "production";
  }>;

  const { data: ws } = await admin
    .from("workspaces")
    .select("avalara_account_id, avalara_license_key_encrypted, avalara_environment")
    .eq("id", workspaceId)
    .single();

  const account_id = body.account_id || ws?.avalara_account_id || "";
  const license_key =
    body.license_key ||
    (ws?.avalara_license_key_encrypted ? decrypt(ws.avalara_license_key_encrypted) : "");
  const environment: "sandbox" | "production" =
    body.environment || (ws?.avalara_environment as "sandbox" | "production") || "sandbox";

  if (!account_id || !license_key) {
    return NextResponse.json({ ok: false, error: "Missing account_id or license_key" }, { status: 400 });
  }

  const result = await pingAvalara(account_id, license_key, environment);
  if (!result.success) {
    return NextResponse.json({ ok: false, error: result.error || "Ping failed" }, { status: 400 });
  }
  return NextResponse.json({
    ok: true,
    authenticated: !!result.authenticated,
    company_name: result.companyName || null,
    environment,
  });
}
