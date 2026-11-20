import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
// ⭐ The in-journey editor dispatches through the SAME shared executors the portal uses —
// there is exactly one implementation of each edit, no forked second copy. Item edits route
// through remedy-actions.executeLineItemAction (→ subscription-items), and skip/date/frequency/add
// through the engine-aware commerce SDK (src/lib/commerce/subscription + src/lib/subscription-items),
// which already route across the three billing engines and carry the portal's mutation guards.
import { executeLineItemAction } from "@/lib/remedy-actions";
import { subAddItem } from "@/lib/subscription-items";
import {
  subscriptionSkipNextOrder,
  subscriptionUpdateNextBillingDate,
  subscriptionUpdateBillingInterval,
} from "@/lib/commerce/subscription";

type Admin = ReturnType<typeof createAdminClient>;

type EditBody = {
  action:
    | "swap_variant"
    | "swap_product"
    | "change_quantity"
    | "remove"
    | "add_item"
    | "skip"
    | "change_date"
    | "change_frequency";
  subscription_id?: string;
  variant_id?: string;
  old_variant_id?: string;
  new_variant_id?: string;
  quantity?: number;
  next_billing_date?: string;
  interval?: "DAY" | "WEEK" | "MONTH" | "YEAR";
  interval_count?: number;
};

type ResolvedSub = { id: string; contractId: string };

/**
 * Resolve the subscription the customer is editing and PROVE it belongs to this
 * session's customer (or a linked account) before returning its contract id.
 * Stops a hand-tampered token from editing someone else's subscription — same
 * ownership guard the cancel completion handler uses.
 */
async function resolveOwnedSubscription(
  admin: Admin,
  workspaceId: string,
  sessionCustomerId: string,
  sessionSubscriptionId: string | null,
  requestedSubId: string | undefined,
): Promise<ResolvedSub | null> {
  const allowedIds = [sessionCustomerId];
  const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", sessionCustomerId).maybeSingle();
  if (link?.group_id) {
    const { data: grp } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id);
    for (const g of grp || []) if (!allowedIds.includes(g.customer_id)) allowedIds.push(g.customer_id);
  }

  const targetId = requestedSubId || sessionSubscriptionId || undefined;
  if (targetId && /^[0-9a-f-]{36}$/i.test(targetId)) {
    const { data: row } = await admin.from("subscriptions")
      .select("id, shopify_contract_id, customer_id")
      .eq("id", targetId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (row?.shopify_contract_id && row.customer_id && allowedIds.includes(row.customer_id)) {
      return { id: row.id, contractId: row.shopify_contract_id };
    }
    return null;
  }

  // No explicit target — auto-pick the customer's lone active/paused sub.
  const { data: liveSubs } = await admin.from("subscriptions")
    .select("id, shopify_contract_id")
    .in("customer_id", allowedIds)
    .eq("workspace_id", workspaceId)
    .in("status", ["active", "paused"]);
  if (liveSubs?.length === 1 && liveSubs[0].shopify_contract_id) {
    return { id: liveSubs[0].id, contractId: liveSubs[0].shopify_contract_id };
  }
  return null;
}

/**
 * POST: apply ONE edit to the customer's subscription inside the next-order journey.
 *
 * Verify-before-report: every edit reads back the executor's result and only reports success
 * when the mutation actually landed (result.success). A failed or unresolvable edit never tells
 * the customer it worked — it leaves the ticket open, raises a high-severity dashboard
 * notification, and tells the customer the team will apply it (CLAUDE.md north-star hard rule,
 * the 2026-11-16 false-success save-flow bug).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const admin = createAdminClient();

  const { data: session } = await admin
    .from("journey_sessions")
    .select("id, workspace_id, ticket_id, customer_id, subscription_id, status, current_step, token_expires_at")
    .eq("token", token)
    .single();

  if (!session) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (new Date(session.token_expires_at) < new Date()) {
    await admin.from("journey_sessions").update({ status: "expired" }).eq("id", session.id);
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }
  if (session.status === "completed") {
    return NextResponse.json({ error: "already_completed" }, { status: 400 });
  }

  const body = (await request.json()) as EditBody;
  const { action } = body;
  if (!action) return NextResponse.json({ error: "action required" }, { status: 400 });

  const wsId = session.workspace_id;
  const sub = await resolveOwnedSubscription(admin, wsId, session.customer_id, session.subscription_id, body.subscription_id);

  if (!sub) {
    return failUnresolved(admin, session.id, session.ticket_id, wsId, action);
  }

  // ── Dispatch through the shared executors ──
  let result: { success: boolean; error?: string; validationError?: string; savedAction?: string };
  try {
    switch (action) {
      case "swap_variant":
        result = await executeLineItemAction(wsId, sub.contractId, {
          action: "swap_variant",
          oldVariantId: body.old_variant_id,
          newVariantId: body.new_variant_id,
        });
        break;
      case "swap_product":
        result = await executeLineItemAction(wsId, sub.contractId, {
          action: "swap_product",
          variantId: body.variant_id,
          newVariantId: body.new_variant_id,
          quantity: body.quantity,
        });
        break;
      case "change_quantity":
        result = await executeLineItemAction(wsId, sub.contractId, {
          action: "change_quantity",
          variantId: body.variant_id,
          quantity: body.quantity,
        });
        break;
      case "remove":
        result = await executeLineItemAction(wsId, sub.contractId, {
          action: "remove",
          variantId: body.variant_id,
        });
        break;
      case "add_item": {
        if (!body.variant_id) { result = { success: false, validationError: "missing_variant_id", savedAction: "" }; break; }
        const r = await subAddItem(wsId, sub.contractId, body.variant_id, body.quantity || 1);
        result = { ...r, savedAction: "added an item to your subscription" };
        break;
      }
      case "skip": {
        const r = await subscriptionSkipNextOrder(wsId, sub.contractId);
        result = { ...r, savedAction: "skipped your next order" };
        break;
      }
      case "change_date": {
        if (!body.next_billing_date) { result = { success: false, validationError: "missing_date", savedAction: "" }; break; }
        const r = await subscriptionUpdateNextBillingDate(wsId, sub.contractId, body.next_billing_date);
        result = { ...r, savedAction: "updated your next delivery date" };
        break;
      }
      case "change_frequency": {
        if (!body.interval || !body.interval_count) { result = { success: false, validationError: "missing_frequency", savedAction: "" }; break; }
        const r = await subscriptionUpdateBillingInterval(wsId, sub.contractId, body.interval, body.interval_count);
        result = { ...r, savedAction: "updated your delivery frequency" };
        break;
      }
      default:
        return NextResponse.json({ error: "unknown_action" }, { status: 400 });
    }
  } catch (err) {
    console.error(`[journey/edit] ${action} threw for session ${session.id}:`, err);
    result = { success: false, error: err instanceof Error ? err.message : "unknown error", savedAction: "" };
  }

  // ── Verify-before-report ──
  if (!result.success) {
    // A bad input is the customer's to fix — surface it without raising an alert.
    if (result.validationError) {
      return NextResponse.json({ success: false, validationError: result.validationError });
    }
    // A real executor failure: never claim the change landed. Leave the ticket
    // open for a human + raise it, and tell the customer the team will apply it.
    await raiseFailedEdit(admin, session.id, session.ticket_id, wsId, action, result.error);
    return NextResponse.json({
      success: false,
      message: "We couldn't apply that change automatically — our team has been notified and will take care of it for you shortly.",
    });
  }

  // Lifecycle event — keyed by the journey_sessions row so M3/M4 can attribute it.
  await admin.from("journey_step_events").insert({
    session_id: session.id,
    workspace_id: wsId,
    step_index: session.current_step || 0,
    step_key: "lifecycle",
    response_value: action === "skip" ? "skipped" : "edited",
    response_label: result.savedAction || action,
  });

  // Internal note so the ticket shows what the customer did.
  if (session.ticket_id) {
    await admin.from("ticket_messages").insert({
      ticket_id: session.ticket_id,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[System] Next-order journey edit "${action}" applied: ${result.savedAction || ""}`.trim(),
    });
  }

  return NextResponse.json({
    success: true,
    message: result.savedAction ? `Done — we've ${result.savedAction}.` : "Done — your subscription has been updated.",
  });
}

async function failUnresolved(
  admin: Admin,
  sessionId: string,
  ticketId: string | null,
  workspaceId: string,
  action: string,
): Promise<NextResponse> {
  console.error(`[journey/edit] no resolvable subscription for session ${sessionId} action ${action}`);
  await raiseFailedEdit(admin, sessionId, ticketId, workspaceId, action, "no resolvable subscription");
  return NextResponse.json({
    success: false,
    message: "We couldn't find the subscription to update — our team has been notified and will follow up with you shortly.",
  });
}

/** Leave the ticket open + raise a high-severity notification for a failed edit. */
async function raiseFailedEdit(
  admin: Admin,
  sessionId: string,
  ticketId: string | null,
  workspaceId: string,
  action: string,
  error: string | undefined,
): Promise<void> {
  if (ticketId) {
    await admin.from("tickets").update({ status: "open", handled_by: null, updated_at: new Date().toISOString() }).eq("id", ticketId);
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[Next-order journey] ⚠ Edit "${action}" failed to apply (${error || "unknown error"}). Customer was told the team will apply it. Apply it manually.`,
    });
  }
  await admin.from("dashboard_notifications").insert({
    workspace_id: workspaceId,
    type: "system",
    title: "Next-order journey edit could not be applied",
    body: ticketId
      ? `Ticket ${ticketId} — a "${action}" edit in the next-order journey failed to apply. Apply it manually.`
      : `A "${action}" edit in the next-order journey failed to apply (session ${sessionId}).`,
    metadata: { severity: "high", ticket_id: ticketId, journey_session_id: sessionId, action },
  });
}
