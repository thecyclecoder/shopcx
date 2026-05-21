-- abandoned_email_sent_at flags cart_drafts that have already received
-- the 30-minute "you left something behind" reminder. The cron picks
-- only rows where this is NULL so a customer never gets the same
-- abandoned cart email twice for the same draft.
--
-- Idle is measured against updated_at (touched by every /api/cart
-- mutation) — an actively-edited cart never qualifies until the
-- customer stops touching it for 30+ minutes.

ALTER TABLE public.cart_drafts
  ADD COLUMN IF NOT EXISTS abandoned_email_sent_at TIMESTAMPTZ;

-- Partial index supporting the cron's exact predicate. Without this
-- the cron does a full scan of cart_drafts every tick.
CREATE INDEX IF NOT EXISTS cart_drafts_abandoned_pending_idx
  ON public.cart_drafts (updated_at)
  WHERE status = 'open'
    AND abandoned_email_sent_at IS NULL
    AND email IS NOT NULL;
