-- Problem/solution lead-in shown above the benefit bar on the PDP hero.
-- Per-product copy: a short headline (the problem) + a transition line that
-- hands off to the benefit cards. Nullable — when unset, no lead-in renders.
ALTER TABLE product_page_content
  ADD COLUMN IF NOT EXISTS benefit_bar_intro text,
  ADD COLUMN IF NOT EXISTS benefit_bar_transition text;
