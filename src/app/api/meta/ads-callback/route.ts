import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encrypt } from "@/lib/crypto";
import { exchangeCodeForToken, metaGraphRequest } from "@/lib/meta/api";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state"); // workspaceId:nonce
  const error = url.searchParams.get("error");
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai";

  if (error || !code || !state) {
    return NextResponse.redirect(
      `${siteUrl}/dashboard/settings/integrations?meta_ads=error&reason=${error || "no_code"}`
    );
  }

  const colonIdx = state.indexOf(":");
  const workspaceId = colonIdx > -1 ? state.substring(0, colonIdx) : state;

  try {
    const { accessToken, expiresIn } = await exchangeCodeForToken(code);

    // Get Meta user info
    const userData = await metaGraphRequest(accessToken, "/me", { fields: "id,name" }) as {
      id: string;
      name: string;
    };

    const admin = createAdminClient();
    await admin.from("meta_connections").upsert({
      workspace_id: workspaceId,
      access_token_encrypted: encrypt(accessToken),
      expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      meta_user_id: userData.id,
      meta_user_name: userData.name,
      is_active: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: "workspace_id" });

    return NextResponse.redirect(
      `${siteUrl}/dashboard/settings/integrations?meta_ads=connected`
    );
  } catch (err) {
    console.error("[Meta Ads OAuth] Error:", err);
    return NextResponse.redirect(
      `${siteUrl}/dashboard/settings/integrations?meta_ads=error&reason=token_exchange`
    );
  }
}
