import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { registerShopifyWebhooks } from "@/lib/shopify-webhook-register";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
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

  const { data: workspace } = await admin
    .from("workspaces")
    .select("shopify_myshopify_domain, shopify_access_token_encrypted")
    .eq("id", workspaceId)
    .single();

  if (!workspace?.shopify_access_token_encrypted || !workspace?.shopify_myshopify_domain) {
    return NextResponse.json({ error: "Shopify not connected" }, { status: 400 });
  }

  const accessToken = decrypt(workspace.shopify_access_token_encrypted);
  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai").trim();
  const webhookUrl = `${siteUrl}/api/webhooks/shopify`;

  const { registered, errors } = await registerShopifyWebhooks(
    workspace.shopify_myshopify_domain,
    accessToken,
    webhookUrl
  );

  return NextResponse.json({ registered, errors });
}
