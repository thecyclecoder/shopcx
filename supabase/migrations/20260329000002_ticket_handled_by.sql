-- Virtual assignee for AI Agent and Workflow-handled tickets
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS handled_by TEXT;
CREATE INDEX IF NOT EXISTS idx_tickets_handled_by ON public.tickets(handled_by) WHERE handled_by IS NOT NULL;
