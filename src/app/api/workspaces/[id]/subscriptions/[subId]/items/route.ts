import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { addLineItem, removeLineItem, updateLineItem } from "@/lib/shopify-subscriptions";
import { logCustomerEvent } from "@/lib/customer-events";

async function getSub(admin: ReturnType<typeof createAdminClient>, workspaceId: string, subId: string) {
  const { data } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, customer_id")
    .eq("id", subId).eq("workspace_id", workspaceId).single();
  return data;
}

// POST: Add item
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; subId: string }> }
) {
  const { id: workspaceId, subId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const sub = await getSub(admin, workspaceId, subId);
  if (!sub) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { variantId, quantity } = await request.json();
  if (!variantId) return NextResponse.json({ error: "variantId required" }, { status: 400 });

  const result = await addLineItem(workspaceId, sub.shopify_contract_id, variantId, quantity || 1);
  if (!result.success) return NextResponse.json({ error: result.error }, { status: 500 });

  if (sub.customer_id) {
    await logCustomerEvent({
      workspaceId, customerId: sub.customer_id,
      eventType: "subscription.item_added", source: "agent",
      summary: `Item added to subscription`,
      properties: { shopify_contract_id: sub.shopify_contract_id, variantId, quantity },
    });
  }

  return NextResponse.json({ ok: true });
}

// PATCH: Update item (quantity or replace)
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; subId: string }> }
) {
  const { id: workspaceId, subId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const sub = await getSub(admin, workspaceId, subId);
  if (!sub) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { lineId, quantity, variantId } = await request.json();
  if (!lineId) return NextResponse.json({ error: "lineId required" }, { status: 400 });

  const updates: { quantity?: number; variantId?: string } = {};
  if (quantity !== undefined) updates.quantity = quantity;
  if (variantId) updates.variantId = variantId;

  const result = await updateLineItem(workspaceId, sub.shopify_contract_id, lineId, updates);
  if (!result.success) return NextResponse.json({ error: result.error }, { status: 500 });

  if (sub.customer_id) {
    await logCustomerEvent({
      workspaceId, customerId: sub.customer_id,
      eventType: "subscription.item_updated", source: "agent",
      summary: variantId ? "Item replaced on subscription" : `Item quantity updated to ${quantity}`,
      properties: { shopify_contract_id: sub.shopify_contract_id, lineId, ...updates },
    });
  }

  return NextResponse.json({ ok: true });
}

// DELETE: Remove item
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; subId: string }> }
) {
  const { id: workspaceId, subId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const sub = await getSub(admin, workspaceId, subId);
  if (!sub) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { lineId } = await request.json();
  if (!lineId) return NextResponse.json({ error: "lineId required" }, { status: 400 });

  const result = await removeLineItem(workspaceId, sub.shopify_contract_id, lineId);
  if (!result.success) return NextResponse.json({ error: result.error }, { status: 500 });

  if (sub.customer_id) {
    await logCustomerEvent({
      workspaceId, customerId: sub.customer_id,
      eventType: "subscription.item_removed", source: "agent",
      summary: "Item removed from subscription",
      properties: { shopify_contract_id: sub.shopify_contract_id, lineId },
    });
  }

  return NextResponse.json({ ok: true });
}
