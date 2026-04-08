import { NextResponse } from "next/server";
import { verifyMagicToken } from "@/lib/magic-link";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: Request) {
  const body = await request.json();
  const { token } = body;

  if (!token) {
    return NextResponse.json({ error: "Token required" }, { status: 400 });
  }

  const payload = verifyMagicToken(token);
  if (!payload) {
    return NextResponse.json({ error: "Invalid or expired login link. Please request a new one." }, { status: 401 });
  }

  // Verify customer exists
  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select("id, email, first_name, shopify_customer_id")
    .eq("id", payload.customerId)
    .eq("workspace_id", payload.workspaceId)
    .single();

  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  // Build portal redirect URL with auth params
  // The portal uses Shopify App Proxy — we construct a URL that the portal can verify
  const { data: ws } = await admin
    .from("workspaces")
    .select("shopify_domain")
    .eq("id", payload.workspaceId)
    .single();

  const shopDomain = ws?.shopify_domain || "superfoodscompany.com";

  // Redirect to the portal with customer context
  // The portal will recognize this as an authenticated session
  const redirectUrl = `https://${shopDomain}/apps/portal?route=home&customer_id=${customer.shopify_customer_id || ""}&email=${encodeURIComponent(customer.email)}&magic=1`;

  return NextResponse.json({ success: true, redirectUrl });
}
