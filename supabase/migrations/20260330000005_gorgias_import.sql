-- Add gorgias_id column to tickets for import dedup
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS gorgias_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_gorgias ON public.tickets(workspace_id, gorgias_id) WHERE gorgias_id IS NOT NULL;

-- Expand channel constraint to include social_comments if not already there
ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_channel_check;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_channel_check
  CHECK (channel IN ('email','chat','meta_dm','sms','help_center','social_comments'));
