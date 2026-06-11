-- PayPal becomes a saved payment method alongside cards. Braintree vaults a
-- PayPal account with its own payment-method token (charged identically to a
-- card), but it has no brand/last4/expiry — it has the payer's email instead.
-- Store that so the saved-method picker can render "PayPal · user@email.com".

alter table public.customer_payment_methods
  add column if not exists paypal_email text;
