-- Portal ban: restrict customer self-serve access
-- Banned customers see a restricted view and can only submit request tickets

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS portal_banned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS portal_banned_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS portal_banned_by uuid DEFAULT NULL;

COMMENT ON COLUMN customers.portal_banned IS 'When true, customer cannot use self-serve portal features';
COMMENT ON COLUMN customers.portal_banned_at IS 'Timestamp of when the customer was banned';
COMMENT ON COLUMN customers.portal_banned_by IS 'workspace_members.id of admin who applied the ban';
