-- Durable inbound dispatch — record a per-message "the ingest fired a ticket/inbound-message
-- event, waiting for the unified handler to claim it" INTENT.
--
-- Phase 2 of docs/brain/specs/durable-inbound-dispatch-no-silently-lost-ticket-event.md. Before this,
-- every ingest chokepoint (widget, email/sms/meta webhooks, portal, journey, csat, help, apply-playbook)
-- did a fire-and-forget `inngest.send({name:'ticket/inbound-message'})` after inserting the customer
-- message. If Inngest silently dropped that send (cold start, a delivery blip), the customer sat
-- unanswered forever and there was NO evidence of an unfired event — ticket c4889020 is the case.
-- The 5-min backstop cron (Phase 3-guarded, shipped 2026-06 as the belt) catches these after
-- ~12 min via a message-age heuristic; the suspenders live HERE: the ingest records intent in the
-- SAME request as the message insert, and the handler CLEARS the intent when it claims the turn.
-- An un-cleared intent that outlives the settle window is an unambiguous lost send — the Phase-3
-- reconciler re-fires exactly those rows (and increments a lost-send counter for observability),
-- instead of relying on message-age alone which cannot distinguish a truly-lost send from a
-- handler that legitimately declined the turn.
--
-- Additive: NULLable, backfills as NULL (pre-Phase-2 messages carry no intent, and the backstop
-- cron still runs its message-age path for them as a floor).

ALTER TABLE public.ticket_messages
  ADD COLUMN IF NOT EXISTS dispatch_pending_at timestamptz;

COMMENT ON COLUMN public.ticket_messages.dispatch_pending_at IS
  'Durable dispatch-intent stamp: set by dispatchInboundMessage() in the same request as the message insert BEFORE firing ticket/inbound-message; cleared by unifiedTicketHandler when it claims the turn. An un-cleared value older than the Phase-3 settle window is an unambiguous lost send that the backstop reconciler re-fires. Phase 2 of durable-inbound-dispatch-no-silently-lost-ticket-event.';

-- Partial index so the Phase-3 reconciler's "un-cleared, aged past settle" scan is cheap. Most
-- rows carry NULL (backfilled + post-handler-clear + backstop-only messages) so the partial keeps
-- the index small — same shape as idx_tickets_do_not_reply / idx_tickets_ai_handled_at.
CREATE INDEX IF NOT EXISTS idx_ticket_messages_dispatch_pending_at
  ON public.ticket_messages (dispatch_pending_at)
  WHERE dispatch_pending_at IS NOT NULL;
