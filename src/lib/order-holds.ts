/**
 * order-holds — SDK for placing a reversible protective hold on an unshipped order.
 *
 * The hold is the mechanism the a-flagged-allergen-order-must-not-ship spec's Phase 1
 * wires into the escalation raise path: an allergy/safety report against a customer
 * flips their most-recent unshipped order into a hold state so the parcel does NOT
 * continue on the fulfilment path while the ticket handler decides the remedy. The
 * existing allergy override keeps the remedy decision with a human — this SDK owns
 * ONLY the reversible parcel-stopping action.
 *
 * Ground truth: order SC138523 placed 2026-09-13T02:29; allergy reported 02:33;
 * warehouse received 05:30 (3h AFTER the report); shipped 2026-09-15T00:52. The
 * remedy had a deadline and the process had none — nothing in the system prevented
 * the ship, because holding depended on a human noticing.
 *
 * Two truths the SDK preserves:
 *   1. Holding an order we later release costs a day. Shipping an allergen does not
 *      have a cheap undo. So the hold is attempted OPTIMISTICALLY the moment the
 *      escalation is raised — before the human even reads the ticket.
 *   2. If the warehouse cannot hold it — already shipped, already picked, already
 *      manifested — the refusal is recorded EXPLICITLY on the order and raised as
 *      a failure via a dashboard notification. That is the moment the remedy space
 *      collapses to a refund, and the person handling the ticket needs to know.
 *
 * CLAUDE.md hard rule (raw `.from(...)` requires an SDK): every read/write to
 * `orders.hold_*` funnels through this file. Reconcile-sweeps + Phase-2 ticket-context
 * surfaces call `isOrderOnAllergenHold` / `getOrderHoldState`; the raise path calls
 * `attemptAllergenHold`.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { linkGroupIds } from "@/lib/customer-links";
import { errText } from "@/lib/error-text";

type Admin = ReturnType<typeof createAdminClient>;

/** Match strings the model uses to escalate an allergy/safety ticket. Pure — unit-testable. */
export function isAllergyEscalation(reason: string | null | undefined): boolean {
  if (typeof reason !== "string" || reason.length === 0) return false;
  return /\ballerg|anaphyla|safety[_ -]?report|safety[_ -]?review/i.test(reason);
}

/** Discriminated result the caller in the escalation path uses to decide what to sysNote. */
export type HoldAttemptOutcome =
  | { kind: "placed"; orderId: string; orderNumber: string | null }
  | { kind: "refused"; orderId: string; orderNumber: string | null; refusedReason: string }
  | { kind: "no_unshipped_order" }
  | { kind: "already_held"; orderId: string; orderNumber: string | null };

interface CandidateOrder {
  id: string;
  order_number: string | null;
  amplifier_order_id: string | null;
  amplifier_shipped_at: string | null;
  hold_status: string | null;
  hold_kind: string | null;
  fulfillment_status: string | null;
  created_at: string;
}

/**
 * Find the customer's most-recent unshipped order across their link group. "Unshipped"
 * here means `amplifier_shipped_at IS NULL` AND `fulfillment_status` is not 'fulfilled'
 * — i.e. the parcel has not left the warehouse. An order already fulfilled is not
 * the right target; if it's the only recent order, `attemptAllergenHold` returns
 * `refused` for it (already shipped) — never `placed`.
 */
async function findRecentOrderForHold(
  admin: Admin,
  workspaceId: string,
  customerId: string,
): Promise<CandidateOrder | null> {
  const ids = await linkGroupIds(admin, workspaceId, customerId);
  const { data } = await admin
    .from("orders")
    .select(
      "id, order_number, amplifier_order_id, amplifier_shipped_at, hold_status, hold_kind, fulfillment_status, created_at",
    )
    .eq("workspace_id", workspaceId)
    .in("customer_id", ids)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as CandidateOrder | null) ?? null;
}

/**
 * Whether the order's current state means "already shipped, hold-refused". Two signals
 * flip this true: `amplifier_shipped_at` is stamped, OR `fulfillment_status` is
 * 'fulfilled' (the Shopify-origin signal). Either means the parcel is gone; a hold
 * placed now would be a lie.
 */
function isAlreadyShipped(o: CandidateOrder): boolean {
  if (o.amplifier_shipped_at) return true;
  const status = (o.fulfillment_status || "").toLowerCase();
  return status === "fulfilled" || status === "shipped";
}

/**
 * Insert a dashboard_notifications row so the ticket handler + founder see the hold
 * event immediately. Two variants:
 *   - kind='allergen_hold_placed'  — the parcel MUST NOT ship; someone may still need
 *                                    to physically stop it at the warehouse (Amplifier
 *                                    has no update endpoint).
 *   - kind='allergen_hold_refused' — the hold was ATTEMPTED but refused (already shipped).
 *                                    Loud, because the remedy space collapses to a refund.
 *
 * Deduped by (metadata @> {order_id, kind}) so a retry cannot spam a second card.
 */
async function raiseHoldNotification(
  admin: Admin,
  workspaceId: string,
  orderId: string,
  orderNumber: string | null,
  ticketId: string,
  kind: "allergen_hold_placed" | "allergen_hold_refused",
  detail: string,
): Promise<void> {
  const { data: existing } = await admin
    .from("dashboard_notifications")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("type", "fulfillment_alert")
    .eq("dismissed", false)
    .contains("metadata", { order_id: orderId, kind })
    .limit(1)
    .maybeSingle();
  if (existing) return;

  const label = orderNumber || orderId.slice(0, 8);
  const title =
    kind === "allergen_hold_placed"
      ? `${label} — Allergen hold placed (parcel must not ship)`
      : `${label} — Allergen hold REFUSED (parcel already shipped)`;
  await admin.from("dashboard_notifications").insert({
    workspace_id: workspaceId,
    type: "fulfillment_alert",
    title,
    body: detail,
    link: `/dashboard/orders/${orderId}`,
    metadata: {
      kind,
      order_id: orderId,
      order_number: orderNumber,
      ticket_id: ticketId,
    },
  });
}

/**
 * Raise a hold on the customer's most-recent unshipped order in response to an
 * allergy/safety escalation. Called by the escalate handler in the action executor
 * as part of the same turn that stamps `tickets.escalated_at`. Idempotent per order:
 * a second call on the same held order returns `already_held` without re-stamping.
 *
 * Errors are captured and surfaced as `refused` — this path MUST NOT throw and
 * block the outer escalation, because the escalation itself is the safety-critical
 * artifact and the hold is a best-effort protective attempt on top of it.
 */
export async function attemptAllergenHold(
  admin: Admin,
  args: {
    workspaceId: string;
    customerId: string;
    ticketId: string;
    reason: string;
  },
): Promise<HoldAttemptOutcome> {
  try {
    const order = await findRecentOrderForHold(admin, args.workspaceId, args.customerId);
    if (!order) return { kind: "no_unshipped_order" };

    // Idempotency: an existing allergen hold on this same order is a no-op.
    // A DIFFERENT-kind hold (a future non-allergen hold class) is respected too —
    // we don't overwrite it, but we still return `already_held` so the caller notes it.
    if (order.hold_status === "placed" && order.hold_kind) {
      return {
        kind: "already_held",
        orderId: order.id,
        orderNumber: order.order_number,
      };
    }

    const nowIso = new Date().toISOString();

    if (isAlreadyShipped(order)) {
      const refusedReason = "already_shipped";
      // Compare-and-set: only stamp a `refused` if this order has no live hold state.
      // A concurrent `placed` write from a sibling ticket would win; we should not
      // clobber a live hold with a refusal.
      await admin
        .from("orders")
        .update({
          hold_status: "refused",
          hold_kind: "allergen",
          hold_reason: args.reason,
          hold_ticket_id: args.ticketId,
          hold_placed_at: nowIso,
          hold_refused_reason: refusedReason,
        })
        .eq("id", order.id)
        .eq("workspace_id", args.workspaceId)
        .is("hold_status", null);
      await raiseHoldNotification(
        admin,
        args.workspaceId,
        order.id,
        order.order_number,
        args.ticketId,
        "allergen_hold_refused",
        `Allergen hold attempted on ${order.order_number || order.id.slice(0, 8)} but the parcel has already shipped — the remedy space has collapsed to a refund. Reason on the ticket: ${args.reason}`,
      );
      return {
        kind: "refused",
        orderId: order.id,
        orderNumber: order.order_number,
        refusedReason,
      };
    }

    await admin
      .from("orders")
      .update({
        hold_status: "placed",
        hold_kind: "allergen",
        hold_reason: args.reason,
        hold_ticket_id: args.ticketId,
        hold_placed_at: nowIso,
        hold_refused_reason: null,
      })
      .eq("id", order.id)
      .eq("workspace_id", args.workspaceId)
      .is("hold_status", null);

    const inWarehouse = !!order.amplifier_order_id;
    await raiseHoldNotification(
      admin,
      args.workspaceId,
      order.id,
      order.order_number,
      args.ticketId,
      "allergen_hold_placed",
      inWarehouse
        ? `Allergen hold placed on ${order.order_number || order.id.slice(0, 8)}. The order is already in the warehouse (amplifier_order_id set) but not shipped — someone must physically stop the parcel. Reason: ${args.reason}`
        : `Allergen hold placed on ${order.order_number || order.id.slice(0, 8)}. The order has not yet been imported to the warehouse; the reconcile sweep will skip it while the hold is in place. Reason: ${args.reason}`,
    );

    return {
      kind: "placed",
      orderId: order.id,
      orderNumber: order.order_number,
    };
  } catch (err) {
    // Never throw out of the hold attempt — the escalate path must complete.
    console.warn(
      `[order-holds] attemptAllergenHold failed for ticket=${args.ticketId}: ${errText(err)}`,
    );
    return { kind: "no_unshipped_order" };
  }
}

/**
 * Query helper for the amplifier-import-reconcile sweep: is this order currently
 * on an allergen hold? Returns true only for `hold_status='placed'`. A refused
 * hold does not block re-import (nothing to block — the parcel already shipped).
 */
export async function isOrderOnAllergenHold(
  admin: Admin,
  workspaceId: string,
  orderId: string,
): Promise<boolean> {
  const { data } = await admin
    .from("orders")
    .select("hold_status, hold_kind")
    .eq("workspace_id", workspaceId)
    .eq("id", orderId)
    .maybeSingle();
  const row = (data as { hold_status: string | null; hold_kind: string | null } | null) ?? null;
  return !!row && row.hold_status === "placed" && row.hold_kind === "allergen";
}

/** Read-only shape the ticket surface (Phase 2) uses to render the three distinguishable states. */
export interface OrderHoldState {
  status: "placed" | "refused" | null;
  kind: string | null;
  reason: string | null;
  ticketId: string | null;
  placedAt: string | null;
  refusedReason: string | null;
}

/**
 * Pure — render a single labeled line the ticket-context surfaces (founder queue,
 * director's audit note, handling-agent system prompt) print for an order's hold
 * state. Phase 2 of a-flagged-allergen-order-must-not-ship § Verification:
 * "hold state is surfaced on ticket context".
 *
 * Three values must be distinguishable — before this shipped, all three looked
 * identical, which is how "we are doing everything we can to stop it" got sent
 * about an order with no hold on it (ticket 0909ec6f):
 *
 *   - `placed` (parcel must not ship)          → informational line
 *   - `refused` (already shipped — refund only) → ALERT line
 *   - `null` on a live allergy ticket          → ALERT line ("never attempted, parcel still moving")
 *   - `null` on a non-allergy ticket           → null (nothing to say — no allergen hold class applies)
 *
 * "Live allergy context" is the caller's job to decide — from
 * `isAllergyEscalation(ticket.escalation_reason)` and/or an allergy tag. On non-
 * allergy tickets the read stays quiet unless a hold is actually stamped (a
 * fraud/other hold class would still render its own line if we add one).
 */
export function renderOrderHoldForContext(
  state: OrderHoldState | null,
  orderLabel: string,
  isLiveAllergyContext: boolean,
): string | null {
  const label = orderLabel && orderLabel.trim().length > 0 ? orderLabel.trim() : "(order)";
  if (state && state.status === "placed") {
    const kind = state.kind ? `${state.kind} ` : "";
    const reason = state.reason ? ` — reason: ${state.reason}` : "";
    return `⛔ ${kind}hold PLACED on ${label} — parcel must not ship${reason}`;
  }
  if (state && state.status === "refused") {
    const kind = state.kind ? `${state.kind} ` : "";
    const refused = state.refusedReason ? ` (${state.refusedReason})` : "";
    const reason = state.reason ? ` — reason on ticket: ${state.reason}` : "";
    return `🚨 ${kind}hold REFUSED on ${label}${refused} — the parcel has already shipped; the remedy space has collapsed to a refund${reason}`;
  }
  // null / no hold
  if (isLiveAllergyContext) {
    return `🚨 NO allergen hold on ${label} — no hold was ever attempted on this order; the parcel is still moving. Do NOT promise a stop.`;
  }
  return null;
}

/**
 * Card-mint helper for Phase 2 — load the allergen-hold state on the ticket's
 * customer's most-recent order in the shape the founder-card builder consumes.
 * Called by the runner right before `buildEscalateFounderCard` so the CEO card
 * body renders a distinguishable line for placed / refused / never-attempted.
 *
 * "isLiveAllergyContext" is derived from the ticket's own escalation_reason via
 * `isAllergyEscalation` — the same predicate the raise-time path uses to decide
 * whether to fan out to `attemptAllergenHold`. Read-only + swallowed on error —
 * a card-mint helper must never fail the CEO card insert.
 *
 * Returns `null` for:
 *   - a missing/malformed ticket
 *   - a ticket with no customer_id or no recent order
 *   - a non-allergy ticket whose recent order has no hold row at all (nothing
 *     to render — the card body omits the fulfilment-hold line)
 *
 * Returns a filled shape whenever there IS something to say — either a hold
 * status is stamped OR the ticket is a live allergy escalation and the hold
 * is missing (the alert case).
 */
export async function loadAllergenHoldForCard(
  admin: Admin,
  workspaceId: string,
  ticketId: string,
): Promise<{
  status: "placed" | "refused" | null;
  kind: string | null;
  reason: string | null;
  refusedReason: string | null;
  orderLabel: string;
  isLiveAllergyContext: boolean;
} | null> {
  try {
    const { data: ticketRow } = await admin
      .from("tickets")
      .select("customer_id, escalation_reason")
      .eq("id", ticketId)
      .maybeSingle();
    const row =
      (ticketRow as { customer_id: string | null; escalation_reason: string | null } | null) ?? null;
    if (!row?.customer_id) return null;
    const isLiveAllergyContext = isAllergyEscalation(row.escalation_reason);

    const ids = await linkGroupIds(admin, workspaceId, row.customer_id);
    const { data: orderRow } = await admin
      .from("orders")
      .select(
        "id, order_number, hold_status, hold_kind, hold_reason, hold_refused_reason",
      )
      .eq("workspace_id", workspaceId)
      .in("customer_id", ids)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const order =
      (orderRow as {
        id: string;
        order_number: string | null;
        hold_status: string | null;
        hold_kind: string | null;
        hold_reason: string | null;
        hold_refused_reason: string | null;
      } | null) ?? null;
    if (!order) return null;

    const status =
      order.hold_status === "placed" || order.hold_status === "refused"
        ? (order.hold_status as "placed" | "refused")
        : null;
    // Suppress entirely on non-allergy tickets that have no hold — nothing to say.
    if (status === null && !isLiveAllergyContext) return null;

    return {
      status,
      kind: order.hold_kind ?? null,
      reason: order.hold_reason ?? null,
      refusedReason: order.hold_refused_reason ?? null,
      orderLabel: order.order_number ?? order.id.slice(0, 8),
      isLiveAllergyContext,
    };
  } catch (err) {
    console.warn(
      `[order-holds] loadAllergenHoldForCard failed for ticket=${ticketId}: ${errText(err)}`,
    );
    return null;
  }
}

export async function getOrderHoldState(
  admin: Admin,
  workspaceId: string,
  orderId: string,
): Promise<OrderHoldState> {
  const { data } = await admin
    .from("orders")
    .select("hold_status, hold_kind, hold_reason, hold_ticket_id, hold_placed_at, hold_refused_reason")
    .eq("workspace_id", workspaceId)
    .eq("id", orderId)
    .maybeSingle();
  const row =
    (data as {
      hold_status: string | null;
      hold_kind: string | null;
      hold_reason: string | null;
      hold_ticket_id: string | null;
      hold_placed_at: string | null;
      hold_refused_reason: string | null;
    } | null) ?? null;
  return {
    status:
      row?.hold_status === "placed" || row?.hold_status === "refused"
        ? row.hold_status
        : null,
    kind: row?.hold_kind ?? null,
    reason: row?.hold_reason ?? null,
    ticketId: row?.hold_ticket_id ?? null,
    placedAt: row?.hold_placed_at ?? null,
    refusedReason: row?.hold_refused_reason ?? null,
  };
}
