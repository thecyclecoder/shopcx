import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logCustomerEvent } from "@/lib/customer-events";
import { decrypt } from "@/lib/crypto";

async function getAppstleCreds(admin: ReturnType<typeof createAdminClient>, workspaceId: string) {
  const { data: ws } = await admin.from("workspaces")
    .select("appstle_api_key_encrypted, shopify_myshopify_domain")
    .eq("id", workspaceId).single();
  if (!ws?.appstle_api_key_encrypted) return null;
  return { apiKey: decrypt(ws.appstle_api_key_encrypted), shop: ws.shopify_myshopify_domain };
}

// POST: Apply coupon
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; subId: string }> }
) {
  const { id: workspaceId, subId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: sub } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, customer_id")
    .eq("id", subId).eq("workspace_id", workspaceId).single();
  if (!sub) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const creds = await getAppstleCreds(admin, workspaceId);
  if (!creds) return NextResponse.json({ error: "Appstle not configured" }, { status: 400 });

  const { couponCode } = await request.json();
  if (!couponCode) return NextResponse.json({ error: "couponCode required" }, { status: 400 });

  const res = await fetch(
    `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-apply-discount?contractId=${sub.shopify_contract_id}&discountCode=${encodeURIComponent(couponCode)}`,
    { method: "PUT", headers: { "X-API-Key": creds.apiKey } }
  );

  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    return NextResponse.json({ error: `Appstle error: ${res.status} ${text}` }, { status: 500 });
  }

  if (sub.customer_id) {
    await logCustomerEvent({
      workspaceId, customerId: sub.customer_id,
      eventType: "subscription.coupon_applied", source: "agent",
      summary: `Coupon "${couponCode}" applied to subscription`,
      properties: { shopify_contract_id: sub.shopify_contract_id, couponCode },
    });
  }

  return NextResponse.json({ ok: true });
}

// DELETE: Remove coupon
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; subId: string }> }
) {
  const { id: workspaceId, subId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: sub } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, customer_id")
    .eq("id", subId).eq("workspace_id", workspaceId).single();
  if (!sub) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const creds = await getAppstleCreds(admin, workspaceId);
  if (!creds) return NextResponse.json({ error: "Appstle not configured" }, { status: 400 });

  const { discountId } = await request.json();
  if (!discountId) return NextResponse.json({ error: "discountId required" }, { status: 400 });

  const res = await fetch(
    `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-remove-discount?contractId=${sub.shopify_contract_id}&discountId=${discountId}`,
    { method: "PUT", headers: { "X-API-Key": creds.apiKey } }
  );

  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    return NextResponse.json({ error: `Appstle error: ${res.status} ${text}` }, { status: 500 });
  }

  if (sub.customer_id) {
    await logCustomerEvent({
      workspaceId, customerId: sub.customer_id,
      eventType: "subscription.coupon_removed", source: "agent",
      summary: "Coupon removed from subscription",
      properties: { shopify_contract_id: sub.shopify_contract_id, discountId },
    });
  }

  return NextResponse.json({ ok: true });
}
