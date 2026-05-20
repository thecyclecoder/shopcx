-- Agent-written notes flagged "Pin for AI" — promoted into Sonnet's
-- pre-context as a dedicated AGENT GUIDANCE block on every subsequent
-- turn, and surfaced to the daily AI analyzer the same way.
--
-- Why a flag instead of a body-prefix marker: agents shouldn't have to
-- remember a magic string, and the UI control makes the affordance
-- explicit. The flag is checked at orchestrator load time, not
-- re-evaluated per turn — so an agent can pin a note mid-conversation
-- and it'll start flowing into context immediately on the next AI run.

ALTER TABLE public.ticket_messages
  ADD COLUMN IF NOT EXISTS is_ai_guidance BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ai_guidance
  ON public.ticket_messages (ticket_id)
  WHERE is_ai_guidance = true;
