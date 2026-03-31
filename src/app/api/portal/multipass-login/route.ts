import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { generateMultipassUrl } from "@/lib/multipass";

export async function POST(req: NextRequest) {
  const { email } = (await req.json()) as { email?: string };
  if (!email?.trim()) return NextResponse.json({ error: "Email required" }, { status: 400 });

  const normalizedEmail = email.trim().toLowerCase();
  const admin = createAdminClient();

  // Find workspace from referer hostname
  const referer = req.headers.get("referer") || "";
  const hostname = referer ? new URL(referer).hostname : "";

  let workspaceId: string | null = null;
  let shop: string | null = null;
  let multipassSecret: string | null = null;

  // Try subdomain match
  const parts = hostname.split(".");
  if (parts.length >= 3 && parts[0] !== "www" && parts[0] !== "app") {
    const slug = parts[0];
    const { data: ws } = await admin
      .from("workspaces")
      .select("id, shopify_myshopify_domain, shopify_multipass_secret_encrypted")
      .eq("help_slug", slug)
      .single();
    if (ws) {
      workspaceId = ws.id;
      shop = ws.shopify_myshopify_domain;
      multipassSecret = ws.shopify_multipass_secret_encrypted ? decrypt(ws.shopify_multipass_secret_encrypted) : null;
    }
  }

  // Try custom domain
  if (!workspaceId && hostname) {
    const { data: ws } = await admin
      .from("workspaces")
      .select("id, shopify_myshopify_domain, shopify_multipass_secret_encrypted, help_slug")
      .eq("help_custom_domain", hostname)
      .single();
    if (ws) {
      workspaceId = ws.id;
      shop = ws.shopify_myshopify_domain;
      multipassSecret = ws.shopify_multipass_secret_encrypted ? decrypt(ws.shopify_multipass_secret_encrypted) : null;
    }
  }

  if (!workspaceId || !shop) {
    return NextResponse.json({ error: "Could not determine workspace" }, { status: 400 });
  }

  if (!multipassSecret) {
    return NextResponse.json({ error: "Multipass not configured. Contact support." }, { status: 400 });
  }

  // Verify customer exists
  const { data: customer } = await admin
    .from("customers")
    .select("id, shopify_customer_id")
    .eq("workspace_id", workspaceId)
    .eq("email", normalizedEmail)
    .single();

  if (!customer) {
    return NextResponse.json({ error: "We couldn't find an account with that email." }, { status: 404 });
  }

  // Build callback URL
  const callbackUrl = `${referer.split("/portal")[0]}/portal/callback?customer_id=${customer.shopify_customer_id}&email=${encodeURIComponent(normalizedEmail)}`;

  // Generate Multipass URL
  const redirectUrl = generateMultipassUrl(shop, multipassSecret, normalizedEmail, callbackUrl);

  return NextResponse.json({ redirect_url: redirectUrl });
}
