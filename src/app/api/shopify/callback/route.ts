import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt, encrypt } from "@/lib/crypto";
import {
  verifyShopifyHmac,
  exchangeShopifyCode,
  fetchShopDetails,
} from "@/lib/shopify";
import { registerShopifyWebhooks } from "@/lib/shopify-webhook-register";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const shop = searchParams.get("shop");
  const state = searchParams.get("state");
  const hmac = searchParams.get("hmac");

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai";

  if (!code || !shop || !state || !hmac) {
    return NextResponse.redirect(`${siteUrl}/dashboard/settings/integrations?shopify=error&reason=missing_params`);
  }

  // Extract workspace_id from state (format: "workspace_id:nonce")
  const colonIdx = state.indexOf(":");
  if (colonIdx === -1) {
    return NextResponse.redirect(`${siteUrl}/dashboard/settings/integrations?shopify=error&reason=invalid_state`);
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
    .select("shopify_oauth_state, shopify_client_id_encrypted, shopify_client_secret_encrypted")
    .eq("id", workspaceId)
    .single();

  if (!workspace) {
    return NextResponse.redirect(`${siteUrl}/dashboard/settings/integrations?shopify=error&reason=workspace_not_found`);
  }

  if (workspace.shopify_oauth_state !== nonce) {
    return NextResponse.redirect(`${siteUrl}/dashboard/settings/integrations?shopify=error&reason=state_mismatch`);
  }

  // Clear the state immediately
  await admin
    .from("workspaces")
    .update({ shopify_oauth_state: null })
    .eq("id", workspaceId);

  // Decrypt credentials
  const clientId = decrypt(workspace.shopify_client_id_encrypted!);
  const clientSecret = decrypt(workspace.shopify_client_secret_encrypted!);

  // Verify HMAC
  const queryObj: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    queryObj[key] = value;
  });

  if (!verifyShopifyHmac(queryObj, clientSecret)) {
    return NextResponse.redirect(`${siteUrl}/dashboard/settings/integrations?shopify=error&reason=hmac_invalid`);
  }

  // Exchange code for access token
  try {
    const { access_token, scope } = await exchangeShopifyCode({
      shop,
      clientId,
      clientSecret,
      code,
    });

    // Discover the real myshopify domain
    const shopDetails = await fetchShopDetails(shop, access_token);

    // Store everything — preserve shopify_domain if already set (user-entered subdomain)
    const { data: existingWs } = await admin.from("workspaces").select("shopify_domain").eq("id", workspaceId).single();
    const updateData: Record<string, unknown> = {
      shopify_access_token_encrypted: encrypt(access_token),
      shopify_myshopify_domain: shopDetails.myshopify_domain,
      shopify_scopes: scope,
    };
    if (!existingWs?.shopify_domain) {
      updateData.shopify_domain = shopDetails.domain || shopDetails.myshopify_domain;
    }
    await admin.from("workspaces").update(updateData).eq("id", workspaceId);

    // Register webhooks for real-time sync
    const webhookUrl = `${siteUrl}/api/webhooks/shopify`;
    const { errors: webhookErrors } = await registerShopifyWebhooks(
      shopDetails.myshopify_domain,
      access_token,
      webhookUrl
    );
    if (webhookErrors.length) {
      console.warn("Webhook registration errors:", webhookErrors);
    }

    return NextResponse.redirect(`${siteUrl}/dashboard/settings/integrations?shopify=connected`);
  } catch (err) {
    console.error("Shopify OAuth error:", err);
    return NextResponse.redirect(`${siteUrl}/dashboard/settings/integrations?shopify=error&reason=token_exchange`);
  }
}
