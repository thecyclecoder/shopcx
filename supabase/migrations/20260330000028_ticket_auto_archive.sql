-- Add 'archived' to ticket status enum and add archive/close tracking columns

-- 1. Add 'archived' to the status CHECK constraint
ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_status_check;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_status_check
  CHECK (status IN ('open', 'pending', 'closed', 'archived'));

-- 2. Add archived_at timestamp for audit trail
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- 3. Add closed_at timestamp for archive clock (7-day timer starts here)
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS closed_at timestamptz;

-- 4. Backfill closed_at for existing closed tickets using resolved_at as best approximation
UPDATE public.tickets
SET closed_at = COALESCE(resolved_at, updated_at)
WHERE status = 'closed' AND closed_at IS NULL;

-- 5. Index for the daily archive cron query
CREATE INDEX IF NOT EXISTS idx_tickets_archive_candidates
  ON public.tickets (status, closed_at)
  WHERE status = 'closed' AND closed_at IS NOT NULL;
