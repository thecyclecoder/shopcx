-- Escalation layer: separate from assignment
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS escalated_to UUID REFERENCES auth.users(id);
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS escalation_reason TEXT;
