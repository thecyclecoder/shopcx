import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { subscriptionAction } from "@/lib/commerce/subscription";
import { cancelOrder } from "@/lib/shopify-order-actions";
import { refundOrder } from "@/lib/refund";
import { validateConfirmCustomerId, appendConfirmedCustomerId } from "@/lib/fraud-confirm";

/**
 * Confirmed Fraud — multi-step action series, PER CUSTOMER.
 *
 * Confirming fraud acts on exactly ONE customer at a time (spec
 * fraud-bin-velocity-requires-real-cross-account-link Phase 3). A case-wide
 * confirm turned a single real fraudster into 8 innocent subscribers refunded,
 * cancelled and banned in one click. EVERY step now requires a single
 * `body.customer_id` that is a member of fraud_cases.customer_ids; a missing id,
 * an array, or a `customer_ids` (plural) body is a 400. Each step is scoped to
 * that one customer — only their subs are cancelled, only their orders refunded,
 * only they are banned, and only they are appended to confirmed_customer_ids.
 *
 * POST body: { step, customer_id, amplifier_action?, proceed_with_cancel? }
 *
 * Steps:
 *   check_amplifier  — Amplifier status for THIS customer's orders in the case
 *   cancel_subscriptions — cancels THIS customer's active subs via Appstle
 *   cancel_refund_orders — cancels + refunds THIS customer's case orders
 *   ban_customer — sets portal_banned on exactly this one customer
 *   complete — appends this customer to confirmed_customer_ids, flips status
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; caseId: string }> }
) {
  const { id: workspaceId, caseId } = await params;

  const { user } = await getAuthedUser();
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

  // ── Per-customer contract (Phase 3) ──
  // Every step acts on exactly one customer. The shared validator rejects the
  // legacy case-wide shapes: a `customer_ids` (plural) body, a missing
  // `customer_id`, an array, or a `customer_id` that isn't a member of this
  // case. This is the guard that makes a grouping mistake impossible to turn
  // into mass damage.
  const validation = validateConfirmCustomerId(body as Record<string, unknown>, customerIds);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: validation.status });
  }
  const customerId = validation.customerId;

  // ── Step: check_amplifier ──
  if (step === "check_amplifier") {
    // Load orders with amplifier data — order_ids may be Shopify IDs or internal UUIDs
    const orders: { id: string; order_number: string; shopify_order_id: string; amplifier_order_id: string | null; amplifier_status: string | null; amplifier_shipped_at: string | null }[] = [];

    if (orderIds.length > 0) {
      // Scope to THIS customer's orders only (`.eq("customer_id", customerId)`).
      // Try as shopify_order_id first
      const { data: byShopify } = await admin.from("orders")
        .select("id, order_number, shopify_order_id, amplifier_order_id, amplifier_status, amplifier_shipped_at")
        .eq("workspace_id", workspaceId)
        .eq("customer_id", customerId)
        .in("shopify_order_id", orderIds);
      if (byShopify?.length) orders.push(...byShopify);

      // For any IDs not found, try as internal UUID
      const foundShopifyIds = new Set(orders.map(o => o.shopify_order_id));
      const missingIds = orderIds.filter(id => !foundShopifyIds.has(id) && !orders.some(o => o.id === id));
      if (missingIds.length) {
        const { data: byUuid } = await admin.from("orders")
          .select("id, order_number, shopify_order_id, amplifier_order_id, amplifier_status, amplifier_shipped_at")
          .eq("workspace_id", workspaceId)
          .eq("customer_id", customerId)
          .in("id", missingIds);
        if (byUuid?.length) orders.push(...byUuid);
      }
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
  //
  // Idempotency: this step's fanout is filtered to `status in
  // ("active","paused")` at the query level, so a step re-fire naturally
  // skips already-cancelled subs — the compare-and-set is inherent in
  // the enumeration source, not the write. A prior fraud-case
  // cancellation on the same sub also lives in `customer_events` as
  // `subscription.cancelled` with `properties.fraud_case_id = caseId`;
  // we look it up per-sub before firing so a mid-loop failure + client
  // retry never re-issues a cancel Appstle would 400 on ("already
  // cancelled").
  if (step === "cancel_subscriptions") {
    const results: { subscription_id: string; shopify_contract_id: string; success: boolean; error?: string; skipped?: string }[] = [];

    // Only THIS customer's active subs — never every customer on the case.
    const { data: subs } = await admin.from("subscriptions")
      .select("id, shopify_contract_id, status")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customerId)
      .in("status", ["active", "paused"]);

    for (const sub of subs || []) {
      // Idempotency precheck — customer_events lookup for a prior
      // fraud-case cancel on the same sub. If found, skip and record
      // "already cancelled by prior fraud attempt" so a retry is safe.
      const { data: priorCancel } = await admin
        .from("customer_events")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("event_type", "subscription.cancelled")
        .contains("properties", { fraud_case_id: caseId, subscription_id: sub.id })
        .limit(1)
        .maybeSingle();
      if (priorCancel) {
        results.push({
          subscription_id: sub.id,
          shopify_contract_id: sub.shopify_contract_id,
          success: true,
          skipped: "already cancelled by prior fraud-case attempt (idempotent skip)",
        });
        continue;
      }
      const result = await subscriptionAction(workspaceId, sub.shopify_contract_id, "cancel", "fraud", "Fraud Detection");
      results.push({
        subscription_id: sub.id,
        shopify_contract_id: sub.shopify_contract_id,
        success: result.success,
        error: result.error,
      });
    }

    return NextResponse.json({ ok: true, step: "cancel_subscriptions", results });
  }

  // ── Step: cancel_refund_orders ──
  //
  // Idempotency: `refundOrder` stamps `customer_events` with
  // `event_type='order.refunded'`, source='fraud' and
  // `properties.fraud_case_id=caseId`. We look up that marker per-order
  // BEFORE firing the refund so a step re-run (mid-loop failure +
  // client retry) skips already-refunded orders instead of double-
  // refunding. This is the compound-write idempotency the DM13
  // enumeration item pins.
  if (step === "cancel_refund_orders") {
    const results: { order_id: string; order_number: string; success: boolean; error?: string; skipped?: string }[] = [];

    for (const oid of orderIds) {
      // order_ids may contain Shopify order IDs (rule-based) or internal UUIDs (AI-detected).
      // Resolve to the internal orders row either way — refundOrder + cancelOrder both need it.
      let dbOrder: { id: string; order_number: string | null; shopify_order_id: string | null; total_cents: number | null; customer_id: string | null } | null = null;

      const { data: orderByShopify } = await admin.from("orders")
        .select("id, order_number, shopify_order_id, total_cents, customer_id")
        .eq("workspace_id", workspaceId)
        .eq("shopify_order_id", oid)
        .maybeSingle();

      if (orderByShopify) {
        dbOrder = orderByShopify;
      } else {
        const { data: orderByUuid } = await admin.from("orders")
          .select("id, order_number, shopify_order_id, total_cents, customer_id")
          .eq("workspace_id", workspaceId)
          .eq("id", oid)
          .maybeSingle();
        if (orderByUuid) dbOrder = orderByUuid;
      }

      if (!dbOrder) {
        results.push({ order_id: oid, order_number: oid, success: false, error: "Order not found" });
        continue;
      }

      // Per-customer scope: skip any case order that isn't THIS customer's.
      // Another customer on the same case is refunded only when THEY are
      // confirmed on their own.
      if (dbOrder.customer_id !== customerId) {
        continue;
      }

      const orderNumber = dbOrder.order_number || oid;
      const totalCents = dbOrder.total_cents || 0;

      // Idempotency precheck — has THIS fraud case already refunded
      // THIS order? refundOrder writes customer_events with
      // event_type='order.refunded', properties.fraud_case_id=caseId,
      // properties.order_id=dbOrder.id. A prior-hit means already
      // refunded → skip the refund + cancel branch entirely so a retry
      // never double-refunds.
      const { data: priorRefund } = await admin
        .from("customer_events")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("event_type", "order.refunded")
        .contains("properties", { fraud_case_id: caseId, order_id: dbOrder.id })
        .limit(1)
        .maybeSingle();
      if (priorRefund) {
        results.push({
          order_id: oid,
          order_number: orderNumber,
          success: true,
          skipped: "already refunded by prior fraud-case attempt (idempotent skip)",
        });
        continue;
      }

      // Phase-3 dispatcher migration — refund via the gateway-aware
      // wrapper (Braintree for internal orders, Shopify for Shopify
      // orders). Then cancel the Shopify order WITHOUT `refund: true`
      // so Shopify doesn't try (and phantom-succeed on Braintree)
      // a second refund. Order matters: refund the money first; if the
      // refund fails, don't leave a canceled but unrefunded order.
      let success = false;
      let error: string | undefined;

      if (totalCents > 0) {
        const refund = await refundOrder(workspaceId, dbOrder.id, totalCents, "Fraud offset — order refund", {
          source: "fraud",
          eventProperties: { fraud_case_id: caseId, reason: "confirmed_fraud", order_id: dbOrder.id },
        });
        if (!refund.success) {
          results.push({ order_id: oid, order_number: orderNumber, success: false, error: `Refund failed: ${refund.error}` });
          continue;
        }
      }

      if (dbOrder.shopify_order_id) {
        const cancelResult = await cancelOrder(workspaceId, dbOrder.shopify_order_id, {
          reason: "FRAUD",
          refund: false,
          restock: true,
          notify: false,
        });
        success = cancelResult.success;
        error = cancelResult.error;
      } else {
        // Internal (SHOPCX*) order — no Shopify order to cancel; the
        // refund above is the whole action.
        success = true;
      }

      results.push({ order_id: oid, order_number: orderNumber, success, error });
    }

    return NextResponse.json({ ok: true, step: "cancel_refund_orders", results });
  }

  // ── Step: ban_customer ──
  //
  // Bans EXACTLY this one customer. The old case-wide fan-out over the
  // resolved linked cluster is gone (spec Phase 3): a confirm never bans
  // several customers at once. Linked accounts are shown for information on
  // the detail page and each needs its own confirm.
  if (step === "ban_customer") {
    const nowIso = new Date().toISOString();
    const results: {
      customer_id: string;
      email: string | null;
      already_banned: boolean;
      banned: boolean;
      success: boolean;
      error?: string;
    }[] = [];

    const { data: row } = await admin.from("customers")
      .select("id, email, portal_banned")
      .eq("workspace_id", workspaceId)
      .eq("id", customerId)
      .maybeSingle();

    if (!row) {
      results.push({ customer_id: customerId, email: null, already_banned: false, banned: false, success: false, error: "Customer not found in workspace" });
    } else if (row.portal_banned) {
      results.push({ customer_id: customerId, email: row.email, already_banned: true, banned: false, success: true });
    } else {
      // Compare-and-set: only flip a currently-unbanned row so a concurrent
      // ban isn't overwritten and exactly one row transitions.
      const { data: updated, error } = await admin.from("customers")
        .update({ portal_banned: true, portal_banned_at: nowIso, portal_banned_by: member.id })
        .eq("id", customerId)
        .eq("workspace_id", workspaceId)
        .eq("portal_banned", false)
        .select("id");
      if (error) {
        results.push({ customer_id: customerId, email: row.email, already_banned: false, banned: false, success: false, error: error.message });
      } else if (!updated || updated.length === 0) {
        results.push({ customer_id: customerId, email: row.email, already_banned: true, banned: false, success: true });
      } else {
        results.push({ customer_id: customerId, email: row.email, already_banned: false, banned: true, success: true });
      }
    }

    const bannedCount = results.filter(r => r.banned).length;
    const alreadyBannedCount = results.filter(r => r.already_banned).length;
    const failedCount = results.filter(r => !r.banned && !r.already_banned).length;

    return NextResponse.json({
      ok: true,
      step: "ban_customer",
      results,
      scope: {
        targeted_customer_ids: [customerId],
        banned_count: bannedCount,
        already_banned_count: alreadyBannedCount,
        failed_count: failedCount,
      },
    });
  }

  // ── Step: complete ──
  //
  // Append THIS customer to confirmed_customer_ids (compare-and-set against the
  // freshest value, no duplicates) and flip the case to confirmed_fraud. The
  // status is a convenience flag; confirmed_customer_ids is the authoritative
  // per-customer record every reader keys on. The history row names the
  // confirmed customer so the audit trail is one-customer-at-a-time.
  if (step === "complete") {
    // Re-read the freshest confirmed_customer_ids so a sibling confirm on the
    // same case (another customer) isn't clobbered, then dedupe-append.
    const { data: fresh } = await admin.from("fraud_cases")
      .select("confirmed_customer_ids")
      .eq("id", caseId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    const prior = (fresh?.confirmed_customer_ids || []) as string[];
    const nextConfirmed = appendConfirmedCustomerId(prior, customerId);

    // Name the customer for the history note.
    const { data: cust } = await admin.from("customers")
      .select("email, first_name, last_name")
      .eq("workspace_id", workspaceId)
      .eq("id", customerId)
      .maybeSingle();
    const custName = cust
      ? (`${cust.first_name || ""} ${cust.last_name || ""}`.trim() || cust.email || customerId)
      : customerId;

    await admin.from("fraud_cases").update({
      status: "confirmed_fraud",
      confirmed_customer_ids: nextConfirmed,
      resolution: body.resolution || `Confirmed fraud for ${custName} — their subscriptions cancelled, orders refunded, account banned`,
      reviewed_by: member.id,
      reviewed_at: new Date().toISOString(),
      review_notes: body.review_notes || `Fraud confirmed for ${custName} via action wizard`,
    }).eq("id", caseId).eq("workspace_id", workspaceId);

    // Record history — names the ONE confirmed customer.
    await admin.from("fraud_case_history").insert({
      case_id: caseId,
      workspace_id: workspaceId,
      user_id: user.id,
      action: "status_changed",
      old_value: fraudCase.status,
      new_value: "confirmed_fraud",
      notes: `Fraud confirmed for ${custName} (customer ${customerId}) via action wizard`,
    });

    return NextResponse.json({ ok: true, step: "complete", confirmed_customer_ids: nextConfirmed });
  }

  return NextResponse.json({ error: "Invalid step" }, { status: 400 });
}
