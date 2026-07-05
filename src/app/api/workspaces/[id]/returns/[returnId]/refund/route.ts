import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { closeReturn } from "@/lib/shopify-returns";
import { refundOrder } from "@/lib/refund";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; returnId: string }> },
) {
  const { id: workspaceId, returnId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { method } = body as { method: "shopify_refund" | "store_credit" };

  if (!method) {
    return NextResponse.json({ error: "method is required (shopify_refund or store_credit)" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Load the return + its stored refund amount + order id — the
  // stored `net_refund_cents` is the contract set at return-creation
  // time (see docs/brain/lifecycles/return-pipeline.md § Phase 4).
  const { data: ret } = await admin
    .from("returns")
    .select("id, order_id, net_refund_cents, order_number, refunded_at")
    .eq("id", returnId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!ret) {
    return NextResponse.json({ error: "Return not found" }, { status: 404 });
  }

  // Idempotency — a previously-refunded return can't refund again.
  if (ret.refunded_at) {
    return NextResponse.json({ error: "Return already refunded" }, { status: 409 });
  }

  if (method === "shopify_refund") {
    // Phase-3 dispatcher migration — refund via the gateway-aware
    // wrapper (routes internal orders to Braintree, Shopify orders to
    // partialRefundByAmount / the Shopify-side Braintree fallback).
    // The prior `processReturn` path used the Shopify `returnProcess`
    // GraphQL mutation and could not refund an internal return.
    if (!ret.net_refund_cents || ret.net_refund_cents <= 0) {
      return NextResponse.json({ error: "Return has no net_refund_cents to refund" }, { status: 400 });
    }
    const r = await refundOrder(workspaceId, ret.order_id, ret.net_refund_cents, `Return ${ret.order_number || returnId} refunded`, {
      source: "agent",
      eventProperties: { return_id: returnId, ui: "returns_admin" },
    });
    if (!r.success) {
      return NextResponse.json({ error: r.error }, { status: 400 });
    }
    // Cosmetic — close the Shopify-side return record if one exists.
    await closeReturn(workspaceId, returnId).catch(() => undefined);
    return NextResponse.json({ success: true, method: r.method });
  }

  const closeResult = await closeReturn(workspaceId, returnId);
  if (!closeResult.success) {
    return NextResponse.json({ error: closeResult.error }, { status: 400 });
  }

  // Mark as refunded with store credit — narrowed by workspace_id +
  // refunded_at IS NULL so we don't overwrite an already-refunded row.
  await admin
    .from("returns")
    .update({
      status: "refunded",
      refunded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", returnId)
    .eq("workspace_id", workspaceId)
    .is("refunded_at", null);

  return NextResponse.json({ success: true, method: "store_credit" });
}
