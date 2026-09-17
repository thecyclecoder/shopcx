-- one_time_charges.rail_reason — a legible record of WHY this rail was chosen.
--
-- Spec: payment-method-lookups-must-span-linked-accounts Phase 2 — "A rail may not silently swap
-- to another card." The pre-existing `rail` column ('braintree' | 'shopify') records the rail that
-- ran, but a Braintree miss that falls through to Shopify looked identical on the row to a caller
-- who NAMED a Shopify method: both settle `rail='shopify'` and nothing on the row said which was
-- which. Post-fix (Phase 1) a Braintree miss should be rare — this column makes it legible when it
-- happens, so 'we billed the Shopify card because we could not find a Braintree token' is a
-- readable row fact rather than an inference from a log line.
--
-- Values (nullable; historical rows keep NULL):
--   'braintree_preferred'          — the customer had an active Braintree card and Braintree ran.
--   'braintree_indeterminate'      — Braintree threw; outcome unknown. Terminal + loud, never a
--                                    fall-through (see the header comment on the executor).
--   'shopify_named_instrument'     — the caller named a specific Shopify PM; Braintree was skipped
--                                    because that authorisation is for the Shopify rail specifically.
--   'shopify_no_braintree_token'   — no active Braintree token in the customer's link group. THIS
--                                    is the fall-through path the spec exists to make legible.
--
-- Nullable so existing rows don't have to be backfilled; the CHECK enforces the enum for writers.
ALTER TABLE public.one_time_charges
  ADD COLUMN IF NOT EXISTS rail_reason text
  CHECK (rail_reason IS NULL OR rail_reason IN (
    'braintree_preferred',
    'braintree_indeterminate',
    'shopify_named_instrument',
    'shopify_no_braintree_token'
  ));

COMMENT ON COLUMN public.one_time_charges.rail_reason IS
  'Why this rail was selected. Distinguishes a Braintree miss that fell through to Shopify (''shopify_no_braintree_token'') from a caller-named Shopify method (''shopify_named_instrument''), both of which settle rail=''shopify'' but for structurally different reasons.';
