-- Transactional messaging settings — owned per-workspace and read by
-- every transactional sender (order confirmation, shipping notice,
-- crisis emails, future SMS receipts, etc.). Lives on workspaces so
-- it doesn't need a join.
--
-- Reply-to is the most-asked-for one: storefront receipts shouldn't
-- send replies into a real human inbox, they should route to the
-- workspace's no-reply autoresponder. Hard-coding the domain was a
-- non-starter because the no-reply mailbox can live on the brand's
-- own domain (no-reply@superfoodscompany.com), not the Resend
-- sending domain.
--
-- From-name + from-local default to sensible values per workspace
-- (workspace.name + "orders") so a fresh workspace works out of the
-- box; nothing breaks if these fields are left null.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS transactional_reply_to_email TEXT,
  ADD COLUMN IF NOT EXISTS transactional_from_email     TEXT,
  ADD COLUMN IF NOT EXISTS transactional_from_name      TEXT;

-- Seed Superfoods with the no-reply@superfoodscompany.com value the
-- founder asked for.
UPDATE public.workspaces
  SET transactional_reply_to_email = 'no-reply@superfoodscompany.com'
  WHERE id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906'
    AND transactional_reply_to_email IS NULL;
