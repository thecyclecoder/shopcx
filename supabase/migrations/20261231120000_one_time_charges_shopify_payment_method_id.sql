-- one_time_charges gains a nullable shopify_payment_method_id — the caller-chosen Shopify
-- payment method to bill.
--
-- WHY. `executeOneTimeCharge` picks the customer's first non-revoked Shopify payment method
-- because Shopify's Customer type exposes no "default payment method" on its GraphQL schema. When
-- a customer has more than one live method, whoever authorised the charge cannot say which card
-- to use — and cannot retry on a different one after a decline. On 2026-09-15 charge 9b7ceee6
-- (ticket a4e79e9d) declined on Amex •1002 while a card •2667 sat unreachable behind it in the
-- same customer's method list. Every blind attempt is a real decline on the customer's account.
--
-- This is the OPTIONAL input the caller supplies. When NULL the behaviour is unchanged (first
-- non-revoked). When present, the executor validates the id against the customer's live methods
-- at charge time and refuses if it is revoked or absent — a stale id must FAIL LOUDLY rather
-- than silently falling back to a different card than the one authorised.
--
-- Distinct from public.one_time_charges.payment_method_id, which records what was ACTUALLY
-- billed (stamped by the executor after the payment method resolves) — the two can differ only
-- if this column was NULL and the executor picked one.

ALTER TABLE public.one_time_charges
  ADD COLUMN IF NOT EXISTS shopify_payment_method_id text;

COMMENT ON COLUMN public.one_time_charges.shopify_payment_method_id IS
  'Caller-chosen Shopify payment method to bill (a gid://shopify/CustomerPaymentMethod/... id). NULL preserves the first-non-revoked default. When present, executeOneTimeCharge validates it against the customer''s live method list and refuses if revoked or absent, so a stale id fails loudly instead of silently billing a different card than the one authorised.';
