import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { appstleSubscriptionAction } from "@/lib/appstle";
import { cancelOrder } from "@/lib/shopify-order-actions";

/**
 * Confirmed Fraud — multi-step action series.
 *
 * POST body: { step, amplifier_action?, proceed_with_cancel? }
 *
 * Steps:
 *   check_amplifier  — returns Amplifier status for each order
 *   cancel_subscriptions — cancels all active subs via Appstle
 *   cancel_refund_orders — cancels + refunds each order on Shopify
 *   ban_customer — sets portal_banned on the customer
 *   complete — marks fraud case as confirmed_fraud
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; caseId: string }> }
) {
  const { id: workspaceId, caseId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Verify admin/owner
  const { data: member } = await admin
    .from("workspace_members")
    .select("id, role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Load fraud case
  const { data: fraudCase } = await admin
    .from("fraud_cases")
    .select("*")
    .eq("id", caseId)
    .eq("workspace_id", workspaceId)
    .single();
  if (!fraudCase) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json();
  const { step } = body as { step: string; amplifier_action?: string; proceed_with_cancel?: boolean };

  const customerIds = (fraudCase.customer_ids || []) as string[];
  const orderIds = (fraudCase.order_ids || []) as string[];

  // ── Step: check_amplifier ──
  if (step === "check_amplifier") {
    // Load orders with amplifier data
    const orders: { id: string; order_number: string; shopify_order_id: string; amplifier_order_id: string | null; amplifier_status: string | null; amplifier_shipped_at: string | null }[] = [];

    if (orderIds.length > 0) {
      const { data } = await admin.from("orders")
        .select("id, order_number, shopify_order_id, amplifier_order_id, amplifier_status, amplifier_shipped_at")
        .eq("workspace_id", workspaceId)
        .in("shopify_order_id", orderIds);
      if (data) orders.push(...data);
    }

    const results = orders.map(o => ({
      order_id: o.shopify_order_id,
      order_number: o.order_number,
      amplifier_order_id: o.amplifier_order_id,
      amplifier_status: o.amplifier_status,
      amplifier_shipped_at: o.amplifier_shipped_at,
      at_amplifier: !!o.amplifier_order_id,
      shipped: !!o.amplifier_shipped_at,
      cancellable: !!o.amplifier_order_id && !o.amplifier_shipped_at && o.amplifier_status === "Processing Shipment",
      amplifier_url: o.amplifier_order_id ? `https://my.amplifier.com/orders/${o.amplifier_order_id}` : null,
    }));

    return NextResponse.json({ ok: true, step: "check_amplifier", orders: results });
  }

  // ── Step: cancel_subscriptions ──
  if (step === "cancel_subscriptions") {
    const results: { subscription_id: string; shopify_contract_id: string; success: boolean; error?: string }[] = [];

    for (const custId of customerIds) {
      const { data: subs } = await admin.from("subscriptions")
        .select("id, shopify_contract_id, status")
        .eq("workspace_id", workspaceId)
        .eq("customer_id", custId)
        .in("status", ["active", "paused"]);

      for (const sub of subs || []) {
        const result = await appstleSubscriptionAction(workspaceId, sub.shopify_contract_id, "cancel", "fraud", "Fraud Detection");
        results.push({
          subscription_id: sub.id,
          shopify_contract_id: sub.shopify_contract_id,
          success: result.success,
          error: result.error,
        });
      }
    }

    return NextResponse.json({ ok: true, step: "cancel_subscriptions", results });
  }

  // ── Step: cancel_refund_orders ──
  if (step === "cancel_refund_orders") {
    const results: { order_id: string; order_number: string; success: boolean; error?: string }[] = [];

    for (const oid of orderIds) {
      // Get order number for display
      const { data: order } = await admin.from("orders")
        .select("order_number, financial_status")
        .eq("workspace_id", workspaceId)
        .eq("shopify_order_id", oid)
        .single();

      const result = await cancelOrder(workspaceId, oid, {
        reason: "FRAUD",
        refund: true,
        restock: true,
        notify: false,
      });
      results.push({
        order_id: oid,
        order_number: order?.order_number || oid,
        success: result.success,
        error: result.error,
      });
    }

    return NextResponse.json({ ok: true, step: "cancel_refund_orders", results });
  }

  // ── Step: ban_customer ──
  if (step === "ban_customer") {
    const results: { customer_id: string; success: boolean }[] = [];

    for (const custId of customerIds) {
      const { error } = await admin.from("customers")
        .update({
          portal_banned: true,
          portal_banned_at: new Date().toISOString(),
          portal_banned_by: member.id,
        })
        .eq("id", custId)
        .eq("workspace_id", workspaceId);
      results.push({ customer_id: custId, success: !error });
    }

    return NextResponse.json({ ok: true, step: "ban_customer", results });
  }

  // ── Step: complete ──
  if (step === "complete") {
    await admin.from("fraud_cases").update({
      status: "confirmed_fraud",
      resolution: body.resolution || "Confirmed fraud — subscriptions cancelled, orders refunded, customer banned",
      reviewed_by: member.id,
      reviewed_at: new Date().toISOString(),
      review_notes: body.review_notes || "Fraud confirmed via action wizard",
    }).eq("id", caseId);

    // Record history
    await admin.from("fraud_case_history").insert({
      case_id: caseId,
      workspace_id: workspaceId,
      user_id: user.id,
      action: "status_changed",
      old_value: fraudCase.status,
      new_value: "confirmed_fraud",
      notes: "Fraud confirmed via action wizard",
    });

    return NextResponse.json({ ok: true, step: "complete" });
  }

  return NextResponse.json({ error: "Invalid step" }, { status: 400 });
}
