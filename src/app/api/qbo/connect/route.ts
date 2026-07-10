import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { cookies } from "next/headers";
import { buildAuthorizeUrl, qboAppCreds } from "@/lib/quickbooks";

/**
 * GET /api/qbo/connect — start the QuickBooks OAuth flow. Owner/admin-gated. Redirects the user to
 * Intuit's consent screen; the callback lands the workspace's OWN refresh token (independent of any
 * other app sharing the same Intuit app). See docs/brain/integrations/quickbooks-online.md.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "no workspace" }, { status: 400 });

  try {
    qboAppCreds(); // fail fast if the app isn't configured
  } catch {
    return NextResponse.json({ error: "QuickBooks not configured (QUICKBOOKS_CLIENT_ID/SECRET)" }, { status: 500 });
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai";
  const redirectUri = `${siteUrl}/api/qbo/callback`;
  const nonce = crypto.randomUUID();
  const state = Buffer.from(JSON.stringify({ workspaceId, userId: user.id, nonce })).toString("base64url");

  const res = NextResponse.redirect(buildAuthorizeUrl(state, redirectUri));
  // CSRF: stash the nonce in an httpOnly cookie; the callback checks it matches state.nonce
  res.cookies.set("qbo_oauth_nonce", nonce, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/" });
  return res;
}
