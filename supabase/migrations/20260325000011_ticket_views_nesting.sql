-- Add parent_id for nested ticket views (up to 2 levels deep)
ALTER TABLE public.ticket_views ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES public.ticket_views(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_ticket_views_parent ON public.ticket_views(parent_id);
