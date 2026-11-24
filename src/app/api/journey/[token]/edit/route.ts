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
} from "@/lib/commerce/subscription";
// ⭐ Portal-parity guards + shared executors (CEO rule, 2026-11-22): the journey must
// run the SAME catalog/price/guard/frequency logic as the Portal, through shared
// helpers both surfaces call — not a forked second copy.
import { changeSubscriptionFrequency } from "@/lib/subscription-frequency";
import { canMutateSubscription, assertNewVariantsSelectable } from "@/lib/portal/mutation-guard";
import { shouldBlockForFailedPayment } from "@/lib/portal/failed-payment-guard";
import { isSwappableConsumable, resolveVariantSwapContexts } from "@/lib/portal/editable-catalog";

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

type ResolvedSub = { id: string; contractId: string; isInternal: boolean; lastPaymentStatus: string | null };

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
      .select("id, shopify_contract_id, customer_id, is_internal, last_payment_status")
      .eq("id", targetId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (row?.shopify_contract_id && row.customer_id && allowedIds.includes(row.customer_id)) {
      return { id: row.id, contractId: row.shopify_contract_id, isInternal: !!row.is_internal, lastPaymentStatus: row.last_payment_status ?? null };
    }
    return null;
  }

  // No explicit target — auto-pick the customer's lone active/paused sub.
  const { data: liveSubs } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, is_internal, last_payment_status")
    .in("customer_id", allowedIds)
    .eq("workspace_id", workspaceId)
    .in("status", ["active", "paused"]);
  if (liveSubs?.length === 1 && liveSubs[0].shopify_contract_id) {
    return { id: liveSubs[0].id, contractId: liveSubs[0].shopify_contract_id, isInternal: !!liveSubs[0].is_internal, lastPaymentStatus: liveSubs[0].last_payment_status ?? null };
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
    return failUnresolved(admin, session, action);
  }

  // ── Portal-parity guards (CEO rule, 2026-11-22) ──
  // The journey must apply the SAME checks the Portal does BEFORE dispatch, and
  // surface a customer-safe validation message (NOT a "team will handle it" failure)
  // when a guard blocks. A blocked guard is the customer's to fix — it never opens a
  // ticket or raises an alert.
  const guardFailure = await runPortalParityGuards(wsId, sub, body);
  if (guardFailure) {
    return NextResponse.json({ success: false, validationError: guardFailure.code, message: guardFailure.message });
  }

  // Removing the only item would empty the subscription. That is a cancel, not an edit: the executor
  // refuses it, so tell the customer up front instead of raising a "could not be applied" alert for a
  // change nobody should apply (2026-11-24: a customer tapped Remove on their only item and the team got
  // a high-severity "apply manually" card).
  if (action === "remove") {
    const { data: row } = await admin.from("subscriptions").select("items").eq("id", sub.id).maybeSingle();
    const lines = Array.isArray(row?.items) ? (row!.items as unknown[]).length : null;
    if (lines !== null && lines <= 1) {
      return NextResponse.json({
        success: false,
        validationError: "last_item",
        message: "This is the only item on your subscription, so it can't be removed. You can swap it for something else, skip your next order, or cancel instead.",
      });
    }
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
        // Shared sequence: engine write → roll next_billing_date forward → display sync
        // (same as the Portal frequency handler). See [[subscription-frequency]].
        const r = await changeSubscriptionFrequency(wsId, sub.contractId, body.interval, body.interval_count);
        result = { success: r.success, error: r.error, savedAction: "updated your delivery frequency" };
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
    await raiseFailedEdit(admin, session, action, result.error);
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

type SessionRow = {
  id: string;
  workspace_id: string;
  ticket_id: string | null;
  customer_id: string;
  subscription_id: string | null;
};

/**
 * Collect the NEW target variant ids a mutating edit selects INTO (swap/add), so the
 * Portal-parity selectability + consumable guards run against the same set the Portal
 * guards in replace-variants.
 */
function newVariantTargets(body: EditBody): string[] {
  const ids: string[] = [];
  if (body.action === "swap_variant" && body.new_variant_id) ids.push(String(body.new_variant_id));
  if (body.action === "swap_product" && body.new_variant_id) ids.push(String(body.new_variant_id));
  if (body.action === "add_item" && body.variant_id) ids.push(String(body.variant_id));
  return ids;
}

/**
 * Apply the SAME checks the Portal applies before a subscription mutation. Returns a
 * customer-safe `{ code, message }` when a guard blocks, or null when every guard
 * passes. A block is the customer's to fix — it never opens a ticket or alerts.
 */
async function runPortalParityGuards(
  workspaceId: string,
  sub: ResolvedSub,
  body: EditBody,
): Promise<{ code: string; message: string } | null> {
  // First-delivery gate (anti-gaming) — identical predicate to the Portal.
  const gate = await canMutateSubscription(workspaceId, { id: sub.id, is_internal: sub.isInternal });
  if (!gate.allowed) {
    return { code: "mutation_gated", message: gate.reason || "This subscription can't be changed yet." };
  }

  // Failed-payment guard — the Portal blocks date + frequency changes on a
  // payment-failed Appstle sub. Mirror that here.
  if ((body.action === "change_date" || body.action === "change_frequency")) {
    if (shouldBlockForFailedPayment({ is_internal: sub.isInternal, last_payment_status: sub.lastPaymentStatus })) {
      return {
        code: "payment_failed_update_blocked",
        message: "This subscription has a failed payment. Update your payment method or cancel before changing it.",
      };
    }
  }

  // Selectability + consumable/in-stock guards on NEW targets (swap/add). The
  // consumable rule is enforced server-side here by applying `isSwappableConsumable`
  // to each resolved (product, variant) — the SAME pure predicate the catalog list
  // filters on, so the UI and the server can never disagree.
  const targets = newVariantTargets(body);
  if (targets.length) {
    const selectable = await assertNewVariantsSelectable(workspaceId, targets);
    if (!selectable.ok) {
      return { code: "variant_not_selectable", message: "That product isn't available to add right now. Please pick another." };
    }
    const contexts = await resolveVariantSwapContexts(workspaceId, targets);
    for (const id of targets) {
      const ctx = contexts.get(id);
      // An unknown variant (not in the catalog) can't be proven swappable → block.
      if (!ctx || !isSwappableConsumable(ctx.product, ctx.variant)) {
        return { code: "variant_not_swappable", message: "That product is out of stock or can't be added to a subscription. Please pick another." };
      }
    }
  }

  return null;
}

/**
 * Guarantee a human owns the promise when a journey edit fails. Reminder sessions are
 * minted with `ticket_id` null (src/lib/pre-renewal-reminders.ts sendTreatmentReminder),
 * so "our team will take care of it" previously pointed at nothing. Create (or reuse)
 * a ticket for the session's customer and stamp it on journey_sessions.ticket_id.
 * Returns the ticket id, or null if the session has no customer to open one for.
 */
export async function ensureJourneyFollowUpTicket(
  admin: Admin,
  session: SessionRow,
): Promise<string | null> {
  if (session.ticket_id) return session.ticket_id;
  if (!session.customer_id) return null;

  const { data: ticket } = await admin
    .from("tickets")
    .insert({
      workspace_id: session.workspace_id,
      customer_id: session.customer_id,
      channel: "email",
      status: "open",
      subject: "Next-order change needs manual help",
    })
    .select("id")
    .maybeSingle();

  const ticketId = ticket?.id as string | undefined;
  if (!ticketId) return null;

  await admin.from("journey_sessions").update({ ticket_id: ticketId }).eq("id", session.id);
  return ticketId;
}

async function failUnresolved(
  admin: Admin,
  session: SessionRow,
  action: string,
): Promise<NextResponse> {
  console.error(`[journey/edit] no resolvable subscription for session ${session.id} action ${action}`);
  await raiseFailedEdit(admin, session, action, "no resolvable subscription");
  return NextResponse.json({
    success: false,
    message: "We couldn't find the subscription to update — our team has been notified and will follow up with you shortly.",
  });
}

/** Ensure a follow-up ticket exists, leave it open + raise a high-severity notification. */
async function raiseFailedEdit(
  admin: Admin,
  session: SessionRow,
  action: string,
  error: string | undefined,
): Promise<void> {
  const ticketId = await ensureJourneyFollowUpTicket(admin, session);
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
    workspace_id: session.workspace_id,
    type: "system",
    title: "Next-order journey edit could not be applied",
    body: ticketId
      ? `Ticket ${ticketId} — a "${action}" edit in the next-order journey failed to apply. Apply it manually.`
      : `A "${action}" edit in the next-order journey failed to apply (session ${session.id}).`,
    metadata: { severity: "high", ticket_id: ticketId, customer_id: session.customer_id, subscription_id: session.subscription_id, journey_session_id: session.id, action },
  });
}
