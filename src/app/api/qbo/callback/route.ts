import { NextRequest, NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import { exchangeCodeForTokens, saveOAuthConnection } from "@/lib/quickbooks";

/**
 * GET /api/qbo/callback — Intuit redirects here with ?code=…&realmId=…&state=… after consent.
 * Validates the CSRF nonce, exchanges the code for the workspace's OWN refresh token, persists the
 * connection (encrypted), and bounces back to the QuickBooks settings page.
 */
const SETTINGS_PATH = "/dashboard/settings/integrations/quickbooks";

function back(siteUrl: string, status: string): NextResponse {
  return NextResponse.redirect(`${siteUrl}${SETTINGS_PATH}?qbo=${status}`);
}

export async function GET(req: NextRequest) {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai";
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const realmId = url.searchParams.get("realmId");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");
  if (err) return back(siteUrl, "denied");
  if (!code || !realmId || !state) return back(siteUrl, "missing_params");

  // decode state + verify CSRF nonce
  let parsed: { workspaceId: string; userId: string; nonce: string };
  try {
    parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
  } catch {
    return back(siteUrl, "bad_state");
  }
  const cookieStore = await cookies();
  const cookieNonce = cookieStore.get("qbo_oauth_nonce")?.value;
  if (!cookieNonce || cookieNonce !== parsed.nonce) return back(siteUrl, "csrf");

  // re-check the user is an owner/admin of the workspace they claim
  const { user } = await getAuthedUser();
  if (!user || user.id !== parsed.userId) return back(siteUrl, "unauthorized");
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", parsed.workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role)) return back(siteUrl, "forbidden");

  try {
    const redirectUri = `${siteUrl}/api/qbo/callback`;
    const tokens = await exchangeCodeForTokens(code, redirectUri);
    await saveOAuthConnection(parsed.workspaceId, { realmId, refreshToken: tokens.refresh_token }, admin);
  } catch {
    return back(siteUrl, "exchange_failed");
  }

  const res = back(siteUrl, "connected");
  res.cookies.delete("qbo_oauth_nonce");
  return res;
}
