import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { subAddItem, subRemoveItem, subChangeQuantity, subSwapVariant } from "@/lib/subscription-items";
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

  const result = await subAddItem(workspaceId, sub.shopify_contract_id, variantId, quantity || 1);
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

  const { variantId, quantity, newVariantId } = await request.json();
  if (!variantId) return NextResponse.json({ error: "variantId required" }, { status: 400 });

  let result: { success: boolean; error?: string };
  let summary: string;

  if (newVariantId) {
    // Swap variant
    result = await subSwapVariant(workspaceId, sub.shopify_contract_id, variantId, newVariantId, quantity || 1);
    summary = "Item replaced on subscription";
  } else if (quantity) {
    // Change quantity
    result = await subChangeQuantity(workspaceId, sub.shopify_contract_id, variantId, quantity);
    summary = `Item quantity updated to ${quantity}`;
  } else {
    return NextResponse.json({ error: "quantity or newVariantId required" }, { status: 400 });
  }

  if (!result.success) return NextResponse.json({ error: result.error }, { status: 500 });

  if (sub.customer_id) {
    await logCustomerEvent({
      workspaceId, customerId: sub.customer_id,
      eventType: "subscription.item_updated", source: "agent",
      summary,
      properties: { shopify_contract_id: sub.shopify_contract_id, variantId, quantity, newVariantId },
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

  const { variantId } = await request.json();
  if (!variantId) return NextResponse.json({ error: "variantId required" }, { status: 400 });

  const result = await subRemoveItem(workspaceId, sub.shopify_contract_id, variantId);
  if (!result.success) return NextResponse.json({ error: result.error }, { status: 500 });

  if (sub.customer_id) {
    await logCustomerEvent({
      workspaceId, customerId: sub.customer_id,
      eventType: "subscription.item_removed", source: "agent",
      summary: "Item removed from subscription",
      properties: { shopify_contract_id: sub.shopify_contract_id, variantId },
    });
  }

  return NextResponse.json({ ok: true });
}
