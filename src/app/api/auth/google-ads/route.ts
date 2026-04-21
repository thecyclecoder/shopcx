import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import crypto from "crypto";

const SCOPES = "https://www.googleapis.com/auth/adwords";

/**
 * GET: Initiate OAuth flow — redirects to Google consent screen.
 * Called when user clicks "Connect Google Ads" in settings.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));

  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspace_id");
  if (!workspaceId) return NextResponse.json({ error: "workspace_id required" }, { status: 400 });

  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces")
    .select("google_ads_client_id")
    .eq("id", workspaceId)
    .single();

  if (!ws?.google_ads_client_id) {
    return NextResponse.json({ error: "Google Ads Client ID not configured" }, { status: 400 });
  }

  // Generate state token for CSRF protection
  const state = crypto.randomBytes(32).toString("hex");
  await admin.from("workspaces").update({
    google_ads_oauth_state: state,
  }).eq("id", workspaceId);

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai";
  const redirectUri = `${siteUrl}/api/auth/google-ads/callback`;

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", ws.google_ads_client_id);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent"); // Force refresh token
  authUrl.searchParams.set("state", `${workspaceId}:${state}`);

  return NextResponse.redirect(authUrl.toString());
}
