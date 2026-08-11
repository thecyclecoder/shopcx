-- PayPal REST credentials on the workspace — the last processor the month-end close could not
-- roll up on ShopCX.
--
-- Why PayPal needs its own credentials rather than riding on Shopify: the GATEWAY on an order may
-- be `paypal` (356 Shopify orders in July 2026) or `PayPal Braintree` (158, mapped → braintree),
-- and that drives the clearing DEBIT from the order side. But the PROCESSOR ROLLUP — fees,
-- refunds, chargebacks — comes from PayPal's own reporting API, because PayPal settles into
-- PayPal and its fees never appear in Shopify's payout summaries. July's PayPal block is real
-- money ($31,166.36 gross / $1,001.92 fees) and cannot be derived from anything ShopCX already
-- holds.
--
-- Secrets are AES-256-GCM via src/lib/crypto.ts per CLAUDE.md — hence `_encrypted`. `client_id`
-- is not a secret and is stored plain, matching braintree_public_key / braintree_merchant_id.
-- See docs/brain/libraries/qb-close-sync-processors.md.

alter table public.workspaces
  add column if not exists paypal_client_id text,
  add column if not exists paypal_client_secret_encrypted text,
  add column if not exists paypal_environment text default 'production';

comment on column public.workspaces.paypal_environment is
  'production | sandbox — selects api-m.paypal.com vs api-m.sandbox.paypal.com';
