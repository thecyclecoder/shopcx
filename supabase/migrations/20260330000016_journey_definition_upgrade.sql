-- Upgrade journey_definitions: add channels, match_patterns, trigger_intent
-- Expand journey_type to include chat journey types

ALTER TABLE public.journey_definitions DROP CONSTRAINT IF EXISTS journey_definitions_journey_type_check;
ALTER TABLE public.journey_definitions ADD CONSTRAINT journey_definitions_journey_type_check
  CHECK (journey_type IN ('cancellation', 'win_back', 'pause', 'product_swap', 'custom', 'account_linking', 'discount_signup', 'return_request', 'address_change'));

ALTER TABLE public.journey_definitions ADD COLUMN IF NOT EXISTS channels TEXT[] DEFAULT '{}';
ALTER TABLE public.journey_definitions ADD COLUMN IF NOT EXISTS match_patterns TEXT[] DEFAULT '{}';
ALTER TABLE public.journey_definitions ADD COLUMN IF NOT EXISTS trigger_intent TEXT;
ALTER TABLE public.journey_definitions ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE public.journey_definitions ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;

-- Migrate chat_journeys data into journey_definitions
INSERT INTO public.journey_definitions (workspace_id, slug, name, journey_type, config, is_active, channels, match_patterns, trigger_intent, description, priority)
SELECT workspace_id, trigger_intent, name, trigger_intent, steps, enabled, channels, match_patterns, trigger_intent, description, priority
FROM public.chat_journeys
ON CONFLICT (workspace_id, slug) DO NOTHING;
