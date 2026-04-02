-- Separate intake clarification turns from AI conversation turns
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS ai_clarification_turns INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS needs_clarification BOOLEAN NOT NULL DEFAULT false;
