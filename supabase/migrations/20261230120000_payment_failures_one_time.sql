-- payment_failures.attempt_type gains 'one_time'.
--
-- A one-time charge that declines was landing ONLY on its own `one_time_charges` row — durable,
-- but nothing reads it. Measured 2026-09-15: customer jratt@me.com was declined $196.08
-- (PAYMENT_METHOD_DECLINED, Amex •1002) and the customer timeline showed 27 events, none of them
-- the decline. An agent picking up his ticket had no way to see it.
--
-- `payment_failures` is the canonical decline ledger — already read by dunning and by decline-rate
-- analytics, and it already carries error_code / payment_method_last4 / billing_attempt_id.
-- `subscription_id` is nullable, which is what makes it usable for a charge that has no
-- subscription. Reusing it beats a new table: one place to ask "why do cards decline here".
--
-- ⚠️ These rows must NEVER open a dunning cycle. A one-time charge is not a subscription at risk;
-- rotating the customer's card and emailing them about a subscription they do not have would be
-- wrong. Dunning selects on subscription_id, which is NULL here, so it cannot pick them up — the
-- `one_time` attempt_type makes that explicit for anyone reading a query.
ALTER TABLE public.payment_failures DROP CONSTRAINT IF EXISTS payment_failures_attempt_type_check;
ALTER TABLE public.payment_failures ADD CONSTRAINT payment_failures_attempt_type_check
  CHECK (attempt_type = ANY (ARRAY['initial'::text, 'card_rotation'::text, 'payday_retry'::text, 'new_card_retry'::text, 'one_time'::text]));

COMMENT ON COLUMN public.payment_failures.attempt_type IS
  'initial | card_rotation | payday_retry | new_card_retry | one_time. `one_time` rows come from public.one_time_charges, carry a NULL subscription_id, and must never open a dunning cycle.';
