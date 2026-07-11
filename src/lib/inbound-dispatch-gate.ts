/**
 * inbound-dispatch-gate — the pure predicate that decides whether a fresh customer inbound message
 * should fire a `ticket/inbound-message` event to [[inngest/unified-ticket-handler]].
 *
 * Purpose: Phase 1 of [[../specs/durable-inbound-dispatch-no-silently-lost-ticket-event]]. Before
 * this module, every ingest chokepoint (widget messages, sms webhook, email webhook, …) branched
 * its re-dispatch decision on the LEGACY `ai_handled` boolean — a stored flag distinct from the
 * universal handling-anchor `ai_handled_at` timestamp stamped by [[ticket-delivery]]
 * `deliverTicketMessage`. Ticket `c4889020` (a chat follow-up) sat unanswered forever because its
 * row carried `ai_handled_at != null` (AI had answered the prior turn) yet the legacy boolean was
 * still `false`, so the divergence case slipped past every ingest gate and no dispatch fired.
 *
 * The predicate here decides off the RELIABLE dispatch-state fields — `ai_handled_at` (universal
 * "AI has handled this ticket" anchor), `assigned_to` (human ownership), `ai_disabled` (human
 * directive to hard-stop AI), `do_not_reply` (deliberate silence marker) — and never reads the
 * stale `ai_handled` boolean. See [[../tables/tickets]] for the field distinctions.
 *
 * Pure over its input — no DB, no clock, no side-effects — so the divergence case is unit-pinned
 * in [[inbound-dispatch-gate.test]]. The handler ([[inngest/unified-ticket-handler]]) re-applies
 * every gate on the receiving end, so this is the SOURCE-side gate; the backstop cron
 * ([[inngest/unanswered-inbound-backstop-cron]]) is the receiving-side safety net.
 */

/**
 * The reliable dispatch-state fields on a `public.tickets` row. Callers pass THIS shape (never the
 * legacy `ai_handled` boolean) so a future refactor cannot re-introduce the divergence bug at the
 * call sites.
 */
export interface InboundDispatchState {
  /** The universal "AI has responded to this ticket" anchor — stamped by `deliverTicketMessage`
   *  on every real customer-facing AI/system-external send. When set, THIS ticket is an
   *  AI-handled conversation and a fresh customer reply MUST redispatch so the handler picks up
   *  the next turn. Never read the legacy `ai_handled` boolean here — it can lag / diverge. */
  ai_handled_at: string | null;
  /** UUID of the workspace member who owns the ticket. Non-null = a human took it — a customer
   *  reply routes to that human, not the AI (unless AI is also handling the conversation via
   *  `ai_handled_at`). */
  assigned_to: string | null;
  /** Hard human directive: "AI is off on this ticket." Overrides everything, including
   *  `ai_handled_at`. The receiving handler also hard-exits on this — this gate saves a
   *  wasted dispatch. */
  ai_disabled: boolean | null;
  /** Deliberate silence marker (mailer-daemon inbound, etc.). Never dispatch — no reply should
   *  ever land back on this ticket. */
  do_not_reply: boolean | null;
}

/**
 * The Phase-1 predicate. Returns true iff a fresh customer inbound message on THIS ticket should
 * fire a `ticket/inbound-message` event.
 *
 * Semantics (in order):
 *  1. `ai_disabled` or `do_not_reply` set → NEVER dispatch (hard human/system directives).
 *  2. `ai_handled_at` set → ALWAYS dispatch. The AI has been handling this conversation; a fresh
 *     customer reply is the next turn regardless of `assigned_to` (which may be a soft/pooled
 *     assignment). This is the divergence case the legacy `ai_handled` boolean got wrong.
 *  3. Otherwise, dispatch iff `assigned_to` is null (no human owns it → AI takes the turn).
 *
 * Pure — no DB, no clock. Unit-pinned in inbound-dispatch-gate.test.ts.
 */
export function shouldDispatchInboundMessage(t: InboundDispatchState): boolean {
  if (t.ai_disabled) return false;
  if (t.do_not_reply) return false;
  if (t.ai_handled_at) return true;
  if (!t.assigned_to) return true;
  return false;
}
