import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { buildShopifyAuthUrl, generateNonce } from "@/lib/shopify";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { workspace_id } = await request.json();
  if (!workspace_id) return NextResponse.json({ error: "workspace_id required" }, { status: 400 });

  const admin = createAdminClient();

  // Verify role
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspace_id)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Get credentials
  const { data: workspace } = await admin
    .from("workspaces")
    .select("shopify_client_id_encrypted, shopify_domain")
    .eq("id", workspace_id)
    .single();

  if (!workspace?.shopify_client_id_encrypted || !workspace?.shopify_domain) {
    return NextResponse.json({ error: "Shopify credentials not configured" }, { status: 400 });
  }

  const clientId = decrypt(workspace.shopify_client_id_encrypted);
  const state = generateNonce();

  // Store state + workspace_id for callback verification
  // Encode workspace_id in the state so callback can find the right workspace
  const statePayload = `${workspace_id}:${state}`;

  await admin
    .from("workspaces")
    .update({ shopify_oauth_state: state })
    .eq("id", workspace_id);

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai";
  const redirectUri = `${siteUrl}/api/shopify/callback`;

  const url = buildShopifyAuthUrl({
    shopDomain: workspace.shopify_domain,
    clientId,
    redirectUri,
    state: statePayload,
  });

  return NextResponse.json({ url });
}
