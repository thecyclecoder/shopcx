-- A crisis row created when a customer RESTARTS a subscription that carried an out-of-stock
-- (crisis) flavor: the line was swapped to the crisis default, and the restart page promised to
-- switch them back once it's restocked. Resolve swaps every auto_swap_back row back to
-- original_item. See docs/brain/libraries/crisis-restart-swap.md.
ALTER TABLE public.crisis_customer_actions
  ADD COLUMN IF NOT EXISTS auto_swap_back boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.crisis_customer_actions.auto_swap_back IS
  'Swap tier1_swapped_to back to original_item automatically when the crisis is resolved (set on restart swaps).';
