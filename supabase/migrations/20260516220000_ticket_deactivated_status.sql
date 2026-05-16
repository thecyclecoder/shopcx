-- ─────────────────────────────────────────────────────────────────
-- "Do not reply" flag on tickets — for tickets where we should never
-- engage further (wrong company, wrong product, spam, accidental,
-- etc).
--
-- Layered on top of status (not a status itself). Most do_not_reply
-- tickets end up status='closed'; the boolean controls AI behavior.
-- A future customer reply gets logged but does NOT trigger:
--   - AI response pipeline (Sonnet orchestrator skips)
--   - Auto-analyzer (re-open + escalate)
--   - Status reopen on customer message
-- An agent can still manually reply if they want — agent action wins.
--
-- The "why" is carried on tags (wrong_product, wrong_company, spam,
-- accidental_send, etc) so analytics can split by reason.
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS do_not_reply BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS do_not_reply_at TIMESTAMPTZ;

COMMENT ON COLUMN public.tickets.do_not_reply IS
  'When true, AI / auto-analyzer / auto-reopen pipelines all skip this ticket. Tag carries the reason (wrong_product, wrong_company, spam, etc).';

-- Partial index for the early-exit check in unified-ticket-handler.
-- Most tickets have do_not_reply=false so the partial keeps the index
-- tiny.
CREATE INDEX IF NOT EXISTS tickets_do_not_reply_idx
  ON public.tickets (workspace_id, do_not_reply)
  WHERE do_not_reply = true;
