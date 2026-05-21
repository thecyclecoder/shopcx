-- portal_migration_enabled gates the "add new payment method →
-- migrate Appstle subscriptions to our internal billing platform"
-- flow. Default OFF — the read-only payment methods list is safe to
-- ship to every workspace, but the migration on update path needs
-- per-workspace opt-in. Flip this when the Braintree integration on
-- the portal is ready end-to-end (vault + retire Appstle contract +
-- carry next_billing_date forward).

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS portal_migration_enabled BOOLEAN NOT NULL DEFAULT false;
