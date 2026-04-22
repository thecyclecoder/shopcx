-- Add next_retry_at and expand dunning_cycles statuses for better tracking
-- New statuses: rotating (trying cards), retrying (payday retries scheduled)

-- Add next_retry_at column
ALTER TABLE public.dunning_cycles ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

-- Drop old check constraint and add new one with rotating + retrying
ALTER TABLE public.dunning_cycles DROP CONSTRAINT IF EXISTS dunning_cycles_status_check;
ALTER TABLE public.dunning_cycles ADD CONSTRAINT dunning_cycles_status_check
  CHECK (status IN ('active', 'rotating', 'retrying', 'skipped', 'paused', 'recovered', 'exhausted'));

-- Update existing 'active' cycles to 'rotating' (they're in card rotation)
UPDATE public.dunning_cycles SET status = 'rotating' WHERE status = 'active';

-- Index for querying upcoming retries
CREATE INDEX IF NOT EXISTS idx_dunning_cycles_next_retry ON dunning_cycles(next_retry_at)
  WHERE next_retry_at IS NOT NULL AND status IN ('rotating', 'retrying');
