import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encrypt } from "@/lib/crypto";
import { exchangeMetaCode, exchangeForPageTokens, subscribePageWebhooks } from "@/lib/meta";
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
  const { user } = await getAuthedUser();
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

    // Exchange for long-lived page tokens — ALL authorized pages, not just first
    const pageResult = await exchangeForPageTokens(appId, appSecret, tokenResult.access_token);

    if ("error" in pageResult) {
      console.error("Meta page token error:", pageResult.error);
      return NextResponse.redirect(`${siteUrl}/dashboard/settings/integrations?meta=error&reason=${encodeURIComponent(pageResult.error)}`);
    }

    const now = new Date().toISOString();
    const firstPage = pageResult.pages[0];

    // Fetch the admin's profile + email (granted via the `email`
    // scope on the user token). Stored on the workspace so we know
    // who connected the page + can show them in the Integrations UI.
    // Best-effort — if /me fails, fall back to empty values.
    let adminEmail: string | null = null;
    let adminName: string | null = null;
    try {
      const meRes = await fetch(`https://graph.facebook.com/v21.0/me?fields=id,name,email&access_token=${encodeURIComponent(tokenResult.access_token)}`);
      if (meRes.ok) {
        const me = await meRes.json() as { id?: string; name?: string; email?: string };
        adminEmail = me.email || null;
        adminName = me.name || null;
      }
    } catch (err) {
      console.warn("Meta callback: failed to fetch /me", err);
    }

    // Legacy single-page columns on workspaces stay populated with the
    // FIRST FB page so older code paths (DM ticket creation, the
    // existing settings card) keep working. Once those callers move
    // over to meta_pages joins we can drop these columns. The user
    // access token persists separately for Marketing API calls
    // (ad creative lookups for product matching).
    const firstEncrypted = encrypt(firstPage.pageAccessToken);
    const userTokenEncrypted = encrypt(pageResult.userAccessToken);
    const workspaceVerifyToken = randomBytes(16).toString("hex");
    await admin
      .from("workspaces")
      .update({
        meta_page_id: firstPage.pageId,
        meta_page_access_token_encrypted: firstEncrypted,
        meta_page_name: firstPage.pageName,
        meta_instagram_id: firstPage.instagramId || null,
        meta_webhook_verify_token: workspaceVerifyToken,
        meta_user_access_token_encrypted: userTokenEncrypted,
        meta_connected_admin_email: adminEmail,
        meta_connected_admin_name: adminName,
      })
      .eq("id", workspaceId);

    // Per-page rows in meta_pages — one for each FB page, plus a
    // separate row for the linked IG business account when present.
    // Per-page tokens so re-auth on one page doesn't rotate others.
    let persisted = 0;
    const subscribeWarnings: string[] = [];
    for (const p of pageResult.pages) {
      const encryptedToken = encrypt(p.pageAccessToken);
      const fbVerifyToken = randomBytes(16).toString("hex");

      const { error: fbErr } = await admin
        .from("meta_pages")
        .upsert(
          {
            workspace_id: workspaceId,
            platform: "facebook",
            meta_page_id: p.pageId,
            meta_page_name: p.pageName,
            meta_instagram_id: p.instagramId || null,
            access_token_encrypted: encryptedToken,
            webhook_verify_token: fbVerifyToken,
            is_active: true,
            connected_at: now,
            updated_at: now,
          },
          { onConflict: "workspace_id,meta_page_id" },
        );
      if (fbErr) {
        console.error(`meta_pages upsert (FB ${p.pageId}) failed:`, fbErr.message);
        continue;
      }
      persisted++;

      // Companion IG row — same FB page token works for IG comments/DMs
      // on the linked Instagram Business Account.
      if (p.instagramId) {
        const igVerifyToken = randomBytes(16).toString("hex");
        const { error: igErr } = await admin
          .from("meta_pages")
          .upsert(
            {
              workspace_id: workspaceId,
              platform: "instagram",
              meta_page_id: p.instagramId,
              meta_page_name: p.instagramName || p.pageName,
              meta_instagram_id: p.instagramId,
              access_token_encrypted: encryptedToken,
              webhook_verify_token: igVerifyToken,
              is_active: true,
              connected_at: now,
              updated_at: now,
            },
            { onConflict: "workspace_id,meta_page_id" },
          );
        if (igErr) console.error(`meta_pages upsert (IG ${p.instagramId}) failed:`, igErr.message);
        else persisted++;
      }

      // Subscribe THIS page's webhook events. One failure shouldn't block
      // the others — accumulate warnings and report at the end.
      const subResult = await subscribePageWebhooks(p.pageId, p.pageAccessToken);
      if (!subResult.success) subscribeWarnings.push(`${p.pageName}: ${subResult.error}`);
    }

    if (subscribeWarnings.length) {
      console.warn("Meta webhook subscription warnings:", subscribeWarnings.join(" | "));
    }

    // Ad-account discovery: handled separately by the ROAS Meta Ads
    // integration (meta_connections + meta_ad_accounts populated via
    // /api/meta-ads-* flows). That's where the user opts in to ads_read
    // and picks which accounts to sync. This Pages OAuth callback only
    // covers page-level scopes (comments, DMs, posts).

    return NextResponse.redirect(`${siteUrl}/dashboard/settings/integrations?meta=connected&pages=${persisted}`);
  } catch (err) {
    console.error("Meta OAuth error:", err);
    return NextResponse.redirect(`${siteUrl}/dashboard/settings/integrations?meta=error&reason=unknown`);
  }
}
