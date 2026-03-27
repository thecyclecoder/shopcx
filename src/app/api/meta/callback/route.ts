import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encrypt } from "@/lib/crypto";
import { exchangeMetaCode, exchangeForPageToken, subscribePageWebhooks } from "@/lib/meta";
import { randomBytes } from "crypto";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai";

  if (!code || !state) {
    return NextResponse.redirect(`${siteUrl}/dashboard/settings/integrations?meta=error&reason=missing_params`);
  }

  // Extract workspace_id from state
  const colonIdx = state.indexOf(":");
  if (colonIdx === -1) {
    return NextResponse.redirect(`${siteUrl}/dashboard/settings/integrations?meta=error&reason=invalid_state`);
  }

  const workspaceId = state.substring(0, colonIdx);
  const nonce = state.substring(colonIdx + 1);

  // Verify user is authenticated
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(`${siteUrl}/login`);
  }

  const admin = createAdminClient();

  // Load workspace and verify state nonce
  const { data: workspace } = await admin
    .from("workspaces")
    .select("meta_oauth_state")
    .eq("id", workspaceId)
    .single();

  if (!workspace) {
    return NextResponse.redirect(`${siteUrl}/dashboard/settings/integrations?meta=error&reason=workspace_not_found`);
  }

  if (workspace.meta_oauth_state !== nonce) {
    return NextResponse.redirect(`${siteUrl}/dashboard/settings/integrations?meta=error&reason=state_mismatch`);
  }

  // Clear the state immediately
  await admin
    .from("workspaces")
    .update({ meta_oauth_state: null })
    .eq("id", workspaceId);

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  if (!appId || !appSecret) {
    return NextResponse.redirect(`${siteUrl}/dashboard/settings/integrations?meta=error&reason=app_not_configured`);
  }

  try {
    const redirectUri = `${siteUrl}/api/meta/callback`;

    // Exchange code for short-lived user token
    const tokenResult = await exchangeMetaCode({
      appId,
      appSecret,
      code,
      redirectUri,
    });

    if ("error" in tokenResult) {
      console.error("Meta token exchange error:", tokenResult.error);
      return NextResponse.redirect(`${siteUrl}/dashboard/settings/integrations?meta=error&reason=token_exchange`);
    }

    // Exchange for long-lived page token
    const pageResult = await exchangeForPageToken(appId, appSecret, tokenResult.access_token);

    if ("error" in pageResult) {
      console.error("Meta page token error:", pageResult.error);
      return NextResponse.redirect(`${siteUrl}/dashboard/settings/integrations?meta=error&reason=${encodeURIComponent(pageResult.error)}`);
    }

    // Generate webhook verify token
    const verifyToken = randomBytes(16).toString("hex");

    // Store everything encrypted
    await admin
      .from("workspaces")
      .update({
        meta_page_id: pageResult.pageId,
        meta_page_access_token_encrypted: encrypt(pageResult.pageAccessToken),
        meta_page_name: pageResult.pageName,
        meta_instagram_id: pageResult.instagramId || null,
        meta_webhook_verify_token: verifyToken,
      })
      .eq("id", workspaceId);

    // Subscribe page to webhook events
    const subResult = await subscribePageWebhooks(pageResult.pageId, pageResult.pageAccessToken);
    if (!subResult.success) {
      console.warn("Meta webhook subscription warning:", subResult.error);
    }

    return NextResponse.redirect(`${siteUrl}/dashboard/settings/integrations?meta=connected`);
  } catch (err) {
    console.error("Meta OAuth error:", err);
    return NextResponse.redirect(`${siteUrl}/dashboard/settings/integrations?meta=error&reason=unknown`);
  }
}
