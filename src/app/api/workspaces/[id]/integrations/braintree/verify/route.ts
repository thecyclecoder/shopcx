/**
 * POST /api/workspaces/{id}/integrations/braintree/verify
 *
 * Tests the workspace's stored Braintree credentials (or a candidate
 * set passed in the body) by calling clientToken.generate. Returns
 *   { ok: true, environment, merchant_id }                  on success
 *   { ok: false, error: "<braintree message>" }             on failure
 *
 * Body shape (all optional — if any field is omitted we fall back to
 * the workspace's stored value, so the UI can verify a partial form):
 *   { merchant_id?, public_key?, private_key?, environment? }
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { verifyBraintreeCredentials } from "@/lib/integrations/braintree";

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
    merchant_id: string;
    public_key: string;
    private_key: string;
    environment: "production" | "sandbox";
  }>;

  // Fill any missing fields from stored config so partial inputs from
  // the UI ("just verify what I have saved") still work.
  const { data: ws } = await admin
    .from("workspaces")
    .select("braintree_merchant_id, braintree_public_key, braintree_private_key_encrypted, braintree_environment")
    .eq("id", workspaceId)
    .single();

  const merchant_id = body.merchant_id || ws?.braintree_merchant_id || "";
  const public_key = body.public_key || ws?.braintree_public_key || "";
  const private_key =
    body.private_key ||
    (ws?.braintree_private_key_encrypted ? decrypt(ws.braintree_private_key_encrypted) : "");
  const environment: "production" | "sandbox" =
    body.environment || (ws?.braintree_environment as "production" | "sandbox") || "production";

  if (!merchant_id || !public_key || !private_key) {
    return NextResponse.json({ ok: false, error: "Missing merchant_id, public_key, or private_key" }, { status: 400 });
  }

  const result = await verifyBraintreeCredentials({ merchant_id, public_key, private_key, environment });
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  return NextResponse.json({ ok: true, merchant_id, environment });
}
