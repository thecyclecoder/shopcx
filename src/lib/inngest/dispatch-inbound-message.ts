/**
 * dispatch-inbound-message — the shared durable dispatcher for the `ticket/inbound-message` event.
 *
 * Phase 2 of [[../../docs/brain/specs/durable-inbound-dispatch-no-silently-lost-ticket-event]].
 * Before this helper, every ingest chokepoint (widget messages, webhooks/email+sms+meta, portal
 * support, journey complete + submit-payment, csat, apply-playbook, help) did a fire-and-forget
 * `inngest.send({name:'ticket/inbound-message'})` after inserting the customer message. If Inngest
 * silently dropped the send (cold start, delivery blip) the customer sat unanswered forever with
 * NO trace of a lost event — ticket `c4889020` was the case-in-point.
 *
 * `dispatchInboundMessage` closes the gap at the source:
 *   1. Stamps `dispatch_pending_at = now` on the just-inserted `ticket_messages` row (durable
 *      intent — a row on disk that says "an ingest chokepoint asked for handling here").
 *   2. Fires the `ticket/inbound-message` event through the Inngest client.
 *
 * The counterpart is [[unified-ticket-handler]] `clearDispatchIntent`: when the handler claims a
 * turn (i.e. actually receives the event), it clears the stamp on the newest un-cleared inbound
 * message for that ticket. That pair — set-on-send + clear-on-claim — is what makes an
 * un-cleared stamp older than the Phase-3 settle window an unambiguous LOST send that the
 * backstop reconciler can re-fire deterministically (instead of Phase 1's message-age heuristic
 * that cannot distinguish "handler declined the turn" from "event was lost").
 *
 * Sentinel events (journey/complete `address_confirmed` / `items_selected`, journey/submit-payment
 * `payment_method_added`, apply-playbook `playbook-apply`) don't have a real INBOUND customer
 * message row on the ticket — they're a coordination signal to wake a playbook. For those the
 * caller omits `dispatchMessageId`; the helper simply fires the event (nothing to stamp). Losing
 * a sentinel is far less severe than losing a customer reply: the customer's real message already
 * has its own durable dispatch through the original channel.
 *
 * Callers that DO have an inserted inbound message MUST pass `dispatchMessageId` from the message
 * insert's `.select('id').single()` result. The stamp is a compare-and-set on that specific row so
 * a caller cannot accidentally stamp a stale row from a different ticket.
 *
 * Every ingest chokepoint routes through this helper — grep `inngest.send({name:'ticket/inbound-
 * message'})` in `src/app/api/**` and `src/lib/portal/**` for compliance (only [[unified-ticket-
 * handler]]'s own re-fire and [[unanswered-inbound-backstop-cron]] may still fire raw).
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export interface DispatchInboundMessageArgs {
  admin: Admin;
  workspaceId: string;
  ticketId: string;
  messageBody: string;
  channel: string;
  isNewTicket: boolean;
  /** UUID of the freshly-inserted inbound `ticket_messages` row that this event answers to. Pass
   *  `null` ONLY for synthetic sentinel events (journey resume signals, playbook wakes) that have
   *  no real customer message row. When set, the helper stamps `dispatch_pending_at = now` on that
   *  specific row BEFORE firing, so the handler's clear-on-claim pairs with it. */
  dispatchMessageId: string | null;
  /** Extra payload keys some sentinel senders attach (journey_session_id, payment_method_id). Kept
   *  optional so the helper's contract stays a strict superset of the raw `inngest.send({data})`
   *  shape callers had before. */
  extra?: Record<string, unknown>;
}

/**
 * Phase-2 durable dispatch. Stamps the intent on the message row (when a `dispatchMessageId` is
 * provided) BEFORE firing the event — the on-disk stamp is what makes a lost send recoverable.
 *
 * Order matters: stamp then send. If the send throws, the stamp on disk lets the Phase-3
 * reconciler re-fire the event after the settle window (an un-cleared stamp with no handler-side
 * activity is precisely the "lost send" signal). If we sent first and then stamped, a crash
 * between send and stamp would leave a lost-send with no durable evidence — the pre-Phase-2 state.
 */
export async function dispatchInboundMessage(args: DispatchInboundMessageArgs): Promise<void> {
  const { admin, workspaceId, ticketId, messageBody, channel, isNewTicket, dispatchMessageId, extra } = args;

  // Stamp intent BEFORE the send. Compare-and-set on the specific message id so a caller can
  // never stamp a stale row (per coaching-guidance #10: mutating writes always narrow with a
  // confirming predicate). We do NOT block on failure to stamp — if the row disappeared under us
  // (a merge redirect racing) the send still needs to fire; the backstop cron will catch a
  // truly-lost handler via its message-age floor for pre-Phase-2 rows.
  if (dispatchMessageId) {
    await admin
      .from("ticket_messages")
      .update({ dispatch_pending_at: new Date().toISOString() })
      .eq("id", dispatchMessageId)
      .eq("ticket_id", ticketId);
  }

  await inngest.send({
    name: "ticket/inbound-message",
    data: {
      workspace_id: workspaceId,
      ticket_id: ticketId,
      message_body: messageBody,
      channel,
      is_new_ticket: isNewTicket,
      ...(extra || {}),
    },
  });
}

/**
 * Handler-side counterpart: clears any un-cleared `dispatch_pending_at` on this ticket's newest
 * inbound customer messages when the unified handler claims the turn. Idempotent — clearing an
 * already-clear row is a no-op update; a ticket with no stamped rows is a no-op.
 *
 * Called from [[unified-ticket-handler]] at the top of the run (before every gate), so a handler
 * that legitimately declines the turn (ai_disabled / do_not_reply / sentinel-no-playbook / empty
 * inbound / spam) still counts as CLAIMED — the event was delivered, and Phase-3 must not re-fire
 * it. The clear is what makes "un-cleared stamp older than settle" a genuine lost-send signal.
 *
 * We clear all un-cleared inbound customer rows for the ticket (not just the newest) so a ticket
 * whose ingest fired multiple stamps rapidly (rare but possible on a burst reply) collapses to a
 * single handler run. That matches the handler's per-ticket concurrency=1 contract.
 */
export async function clearDispatchIntent(admin: Admin, ticketId: string): Promise<void> {
  await admin
    .from("ticket_messages")
    .update({ dispatch_pending_at: null })
    .eq("ticket_id", ticketId)
    .not("dispatch_pending_at", "is", null);
}
