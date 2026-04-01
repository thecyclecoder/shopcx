-- Remedy tracking overhaul:
-- 1. Consolidate free_gift/product_swap into free_product/line_item_modifier
-- 2. Fix remedy_outcomes outcome values (accepted/declined/passed_over/rejected)
-- 3. Add shown + session_id columns for proper tracking

-- ── 1. Consolidate remedy types ──
UPDATE public.remedies SET type = 'free_product' WHERE type = 'free_gift';
UPDATE public.remedies SET type = 'line_item_modifier' WHERE type = 'product_swap';

ALTER TABLE public.remedies DROP CONSTRAINT IF EXISTS remedies_type_check;
ALTER TABLE public.remedies ADD CONSTRAINT remedies_type_check
  CHECK (type IN ('coupon', 'pause', 'skip', 'frequency_change', 'free_product', 'line_item_modifier'));

-- ── 2. Fix remedy_outcomes ──
-- Drop old constraint and add new one with correct values
ALTER TABLE public.remedy_outcomes DROP CONSTRAINT IF EXISTS remedy_outcomes_outcome_check;
ALTER TABLE public.remedy_outcomes ALTER COLUMN outcome DROP NOT NULL;
ALTER TABLE public.remedy_outcomes ADD CONSTRAINT remedy_outcomes_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('accepted', 'passed_over', 'rejected'));

-- Add tracking columns
ALTER TABLE public.remedy_outcomes
  ADD COLUMN IF NOT EXISTS shown BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS session_id UUID;

-- Drop old columns that don't fit new schema (source was non-standard)
-- Keep accepted column for backward compat but it's now derived from outcome

-- Index for stats queries
CREATE INDEX IF NOT EXISTS idx_remedy_outcomes_stats
  ON public.remedy_outcomes (workspace_id, remedy_id, shown, outcome);

CREATE INDEX IF NOT EXISTS idx_remedy_outcomes_reason_stats
  ON public.remedy_outcomes (workspace_id, cancel_reason, remedy_id, shown, outcome);

CREATE INDEX IF NOT EXISTS idx_remedy_outcomes_session
  ON public.remedy_outcomes (session_id) WHERE session_id IS NOT NULL;
