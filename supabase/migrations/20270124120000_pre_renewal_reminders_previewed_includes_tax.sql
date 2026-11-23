-- pre_renewal_reminders — previewed_includes_tax (spec: renewal-reminder-launch-followups
-- Phase 1 · [[../../docs/brain/tables/pre_renewal_reminders]]).
--
-- The reminder now states the FULL amount the renewal will charge — merchandise after discounts +
-- shipping + tax — resolved from the SAME path the renewal charge uses (internal subs: the Avalara
-- quote-only path; shopcx subs: Shopify computes tax at billing, so the amount is shown 'plus tax').
-- We already stamp the shown amount on previewed_amount_cents; this column records WHETHER that
-- amount already includes tax, so the launch audit can compare the previewed figure to the real
-- renewal charge and tell a tax-inclusive 'total' from a pre-tax 'plus tax' estimate.
--
--   true  → every resolved-amount preview was tax-inclusive ('total')
--   false → at least one preview was a pre-tax 'plus tax' figure
--   null  → no amount resolved (reminder omitted the amount)
--
-- Idempotent: ADD COLUMN IF NOT EXISTS (CLAUDE.md idempotent-SQL-migration rail).

ALTER TABLE public.pre_renewal_reminders
  ADD COLUMN IF NOT EXISTS previewed_includes_tax boolean;
