-- Multi-turn AI conversation handling

-- Turn tracking on tickets
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS ai_turn_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS ai_turn_limit INTEGER NOT NULL DEFAULT 4;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS last_ai_turn_at TIMESTAMPTZ;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS topic_drift_detected BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS agent_intervened BOOLEAN NOT NULL DEFAULT false;

-- Per-channel turn limits on ai_channel_config
ALTER TABLE public.ai_channel_config ADD COLUMN IF NOT EXISTS ai_turn_limit INTEGER NOT NULL DEFAULT 4;
