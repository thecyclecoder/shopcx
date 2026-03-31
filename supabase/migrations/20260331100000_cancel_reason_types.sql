-- Cancel flow redesign: reason types + updated remedy types
-- 1. Cancel reasons get type (remedy vs ai_conversation) + suggested_remedy_id
--    Reasons are stored in workspaces.portal_config JSONB, so no table changes needed.
--    The new fields (type, suggested_remedy_id) are added at the application layer.

-- 2. Update remedies type CHECK constraint:
--    Remove: social_proof, ai_conversation, specialist
--    Add: free_product, line_item_modifier

-- Drop old constraint and add new one
ALTER TABLE public.remedies DROP CONSTRAINT IF EXISTS remedies_type_check;
ALTER TABLE public.remedies ADD CONSTRAINT remedies_type_check
  CHECK (type IN ('coupon', 'pause', 'skip', 'frequency_change', 'product_swap', 'free_gift', 'free_product', 'line_item_modifier'));

-- Migrate any existing rows with removed types to a sensible default
UPDATE public.remedies SET enabled = false WHERE type IN ('social_proof', 'ai_conversation', 'specialist');
-- Re-type old social_proof/ai_conversation/specialist to frequency_change (disabled) so constraint passes
UPDATE public.remedies SET type = 'frequency_change' WHERE type IN ('social_proof', 'ai_conversation', 'specialist');
