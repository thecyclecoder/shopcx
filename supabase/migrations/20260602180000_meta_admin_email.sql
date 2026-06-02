-- Capture the email of the Facebook user who connected the page,
-- pulled from /me?fields=email after OAuth using the user-token leg
-- of the new email scope. Lets us:
--   1. Show "Connected by alice@example.com" in the Integrations UI
--   2. Re-contact the admin if the page token rotates and we need
--      a re-auth nudge
--   3. Satisfy Meta App Review's data-use declaration for `email`

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS meta_connected_admin_email TEXT,
  ADD COLUMN IF NOT EXISTS meta_connected_admin_name TEXT;

COMMENT ON COLUMN public.workspaces.meta_connected_admin_email IS
  'Email of the FB user who authorized the Meta integration (from /me?fields=email at OAuth callback). Stored only with the `email` scope granted.';
