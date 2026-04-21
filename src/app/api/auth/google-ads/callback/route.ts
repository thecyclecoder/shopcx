import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encrypt, decrypt } from "@/lib/crypto";

/**
 * GET: OAuth callback — exchanges authorization code for refresh token.
 * Google redirects here after the user approves access.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(new URL(`/dashboard/settings/integrations/google-seo?error=${encodeURIComponent(error)}`, request.url));
  }

  if (!code || !state) {
    return NextResponse.redirect(new URL("/dashboard/settings/integrations/google-seo?error=missing_params", request.url));
  }

  // Parse state: workspaceId:stateToken
  const [workspaceId, stateToken] = state.split(":");
  if (!workspaceId || !stateToken) {
    return NextResponse.redirect(new URL("/dashboard/settings/integrations/google-seo?error=invalid_state", request.url));
  }

  const admin = createAdminClient();

  // Verify state token
  const { data: ws } = await admin.from("workspaces")
    .select("google_ads_oauth_state, google_ads_client_id, google_ads_client_secret_encrypted")
    .eq("id", workspaceId)
    .single();

  if (!ws || ws.google_ads_oauth_state !== stateToken) {
    return NextResponse.redirect(new URL("/dashboard/settings/integrations/google-seo?error=state_mismatch", request.url));
  }

  if (!ws.google_ads_client_id || !ws.google_ads_client_secret_encrypted) {
    return NextResponse.redirect(new URL("/dashboard/settings/integrations/google-seo?error=no_credentials", request.url));
  }

  const clientSecret = decrypt(ws.google_ads_client_secret_encrypted);
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai";
  const redirectUri = `${siteUrl}/api/auth/google-ads/callback`;

  // Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: ws.google_ads_client_id,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error("[google-ads-callback] Token exchange failed:", err);
    return NextResponse.redirect(new URL("/dashboard/settings/integrations/google-seo?error=token_exchange_failed", request.url));
  }

  const tokens = await tokenRes.json();

  if (!tokens.refresh_token) {
    return NextResponse.redirect(new URL("/dashboard/settings/integrations/google-seo?error=no_refresh_token", request.url));
  }

  // Save the refresh token
  await admin.from("workspaces").update({
    google_ads_refresh_token_encrypted: encrypt(tokens.refresh_token),
    google_ads_oauth_state: null, // Clear state
  }).eq("id", workspaceId);

  return NextResponse.redirect(new URL("/dashboard/settings/integrations/google-seo?success=google_ads_connected", request.url));
}
