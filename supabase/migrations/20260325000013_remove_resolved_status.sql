-- Remove "resolved" status — consolidate to open, pending, closed
-- First migrate any existing resolved tickets to closed
UPDATE public.tickets SET status = 'closed' WHERE status = 'resolved';

-- Update the check constraint
ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_status_check;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_status_check
  CHECK (status IN ('open', 'pending', 'closed'));
