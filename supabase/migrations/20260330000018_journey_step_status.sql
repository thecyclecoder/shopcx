-- Ticket status to set when a journey sends a step to the customer
-- Options: 'open', 'pending', 'closed' (default: 'open' for backward compat)
ALTER TABLE public.journey_definitions ADD COLUMN IF NOT EXISTS step_ticket_status TEXT NOT NULL DEFAULT 'open';
