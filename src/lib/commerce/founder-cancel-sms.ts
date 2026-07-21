/**
 * Founder Amplifier-cancel SMS — Phase 2 of
 * [[../../../docs/brain/specs/sol-crisis-swap-rejected-full-refund-and-sms-founder-to-cancel-amplifier-order]].
 *
 * Amplifier exposes no cancel API — the only way to stop a still-cancellable
 * order is for the founder to log in and cancel it manually. This module is the
 * best-effort, idempotent emitter Sol calls when Phase 1's classifier
 * ([[./crisis-swap-rejected]]) flags an order as `crisis_swap_rejected` and
 * the order is still stoppable: `amplifier_order_id` is null (not yet imported
 * to Amplifier) OR the order is in Amplifier but its `amplifier_status` is not
 * yet `Shipped`.
 *
 * Reuses the founder-phone plumbing ([[../god-mode]] `resolveFounderPhone` →
 * `workspaces.god_mode_sms_number` / `GOD_MODE_FOUNDER_PHONE`) and the Twilio
 * send path ([[../twilio]] `sendSMS`). Idempotency is a `customer_events` row
 * of `event_type='order.founder_cancel_amplifier_sms_sent'` scoped to
 * `(workspace_id, properties.order_id)` — the durable ledger the second run
 * short-circuits against so the same order never gets two cancel texts (learning
 * #6/#7 — the confirming-predicate guard at the action point).
 *
 * Silent no-op — NEVER throws — when:
 *   • the order is already Shipped in Amplifier (`amplifier_status === 'Shipped'`);
 *     the caller routes to the return/refund-on-receipt path instead.
 *   • the same order already has the idempotency event on the ledger.
 *   • no founder phone is resolvable (workspace column empty AND env unset).
 *   • Twilio is not configured (`sendSMS` returns `success:false` with a reason).
 *
 * Stamp the ledger ONLY on a delivered SMS — the discipline
 * [[../god-mode]] `nudgeStalePendingApprovals` follows. A transient Twilio
 * failure leaves no ledger row, so the next attempt retries.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { errText } from "@/lib/error-text";

import { resolveFounderPhone } from "@/lib/god-mode";
import { sendSMS } from "@/lib/twilio";

type Admin = SupabaseClient;

/** The `customer_events.event_type` this module writes on a successful send.
 *  Also the exact string the idempotency read filters on. */
export const FOUNDER_CANCEL_AMPLIFIER_EVENT = "order.founder_cancel_amplifier_sms_sent";

/** Amplifier statuses that DISQUALIFY a founder cancel-SMS (order is already
 *  downstream — return path only). `Shipped` is the deterministic marker the
 *  amplifier webhook stamps ([[../inngest/amplifier-webhooks]]). */
const SHIPPED_STATUSES = new Set(["Shipped"]);

/** True when the Amplifier status marks the order as already shipped. Case- +
 *  whitespace-insensitive so a raw webhook value (`" Shipped"`) still routes
 *  to the return path.  Pure. */
export function isAmplifierOrderShipped(status: string | null | undefined): boolean {
  if (!status) return false;
  return SHIPPED_STATUSES.has(String(status).trim());
}

export interface FounderCancelAmplifierSMSArgs {
  workspaceId: string;
  orderId: string;
}

export interface FounderCancelAmplifierSMSResult {
  sent: boolean;
  /** Human-legible one-liner citing why the emitter did (or did not) fire —
   *  the caller can lift this straight into the internal audit note. */
  reason?: string;
  order_number?: string | null;
  message_sid?: string | null;
}

/**
 * Best-effort, idempotent founder cancel-SMS emitter. Reads the order,
 * short-circuits on Shipped / already-texted / no-phone / twilio-not-configured,
 * otherwise sends the SMS and stamps the ledger row. Returns `{ sent, reason,
 * order_number }` — the caller reads `sent` for the audit note, `reason` for
 * the explanation. NEVER throws.
 */
export async function sendFounderCancelAmplifierSMS(
  admin: Admin,
  args: FounderCancelAmplifierSMSArgs,
): Promise<FounderCancelAmplifierSMSResult> {
  try {
    if (!args.workspaceId || !args.orderId) {
      return { sent: false, reason: "workspaceId and orderId are required" };
    }

    // ── 1. Read the order (order_number + amplifier_status) ─────────────────
    const { data: orderRow } = await admin
      .from("orders")
      .select("id, order_number, amplifier_status")
      .eq("id", args.orderId)
      .eq("workspace_id", args.workspaceId)
      .maybeSingle();
    const order = orderRow as {
      id: string;
      order_number: string | null;
      amplifier_status: string | null;
    } | null;
    if (!order) return { sent: false, reason: "order not found in this workspace" };
    const orderNumber = order.order_number;

    // ── 2. Shipped-guard — never send if Amplifier already shows Shipped ──
    if (isAmplifierOrderShipped(order.amplifier_status)) {
      return {
        sent: false,
        reason: "order already Shipped in Amplifier — return path, not founder cancel",
        order_number: orderNumber,
      };
    }

    // ── 3. Idempotency ledger — never re-text the same order ──────────────
    //
    // Confirming-predicate guard (learning #6/#7): the write below fires ONLY
    // when this read returns zero rows for (workspace_id, event_type, order_id).
    // The read is jsonb-scoped so the same order across two workspaces can't
    // cross the boundary.
    const { data: prior } = await admin
      .from("customer_events")
      .select("id")
      .eq("workspace_id", args.workspaceId)
      .eq("event_type", FOUNDER_CANCEL_AMPLIFIER_EVENT)
      .filter("properties->>order_id", "eq", args.orderId)
      .limit(1)
      .maybeSingle();
    if (prior) {
      return {
        sent: false,
        reason: "founder cancel-SMS already sent for this order — not re-texting",
        order_number: orderNumber,
      };
    }

    // ── 4. Resolve founder phone — silent no-op when unset ────────────────
    const to = await resolveFounderPhone(admin, args.workspaceId);
    if (!to) {
      return {
        sent: false,
        reason: "no founder phone configured (god_mode_sms_number / GOD_MODE_FOUNDER_PHONE)",
        order_number: orderNumber,
      };
    }

    // ── 5. Compose + send ─────────────────────────────────────────────────
    const orderLabel = orderNumber || args.orderId;
    const body = `please try to cancel order ${orderLabel} in Amplifier before it ships`;

    const r = await sendSMS(args.workspaceId, to, body);
    if (!r.success) {
      return {
        sent: false,
        reason: r.error || "sendSMS failed",
        order_number: orderNumber,
      };
    }

    // ── 6. Stamp the ledger on SUCCESSFUL send ONLY ───────────────────────
    //
    // Matches the [[../god-mode]] `nudgeStalePendingApprovals` discipline —
    // never stamp on a transient failure or the next attempt would silently
    // skip a message the founder never actually received.
    await admin.from("customer_events").insert({
      workspace_id: args.workspaceId,
      customer_id: null,
      event_type: FOUNDER_CANCEL_AMPLIFIER_EVENT,
      source: "sol",
      summary: `Texted founder to cancel order ${orderLabel} in Amplifier`,
      properties: {
        order_id: args.orderId,
        order_number: orderNumber,
        message_sid: r.messageSid ?? null,
      },
    });

    return { sent: true, order_number: orderNumber, message_sid: r.messageSid ?? null };
  } catch (e) {
    // Never throws — best-effort, matches [[../god-mode]] `sendGodModeSMS`.
    return { sent: false, reason: errText(e) };
  }
}
