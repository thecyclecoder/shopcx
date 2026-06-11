-- Internal-traffic exclusion for the storefront funnel.
--
-- Two independent signals mark a session as "ours" (team/testing) so the
-- funnel can exclude it:
--   1. customers.is_internal — set on team/test customer records. Any session
--      that stitches to one is excluded across all devices, no setup needed.
--   2. storefront_sessions.is_internal — set from a long-lived `sx_internal`
--      cookie, so a flagged browser/device is excluded even while browsing
--      anonymously (logged out). Visit the storefront with ?sx_internal=1 to
--      mark a device, ?sx_internal=0 to clear it.
--
-- The funnel API treats a session as internal if EITHER is true.

alter table public.storefront_sessions
  add column if not exists is_internal boolean not null default false;

alter table public.customers
  add column if not exists is_internal boolean not null default false;

create index if not exists idx_storefront_sessions_is_internal
  on public.storefront_sessions (workspace_id) where is_internal;
create index if not exists idx_customers_is_internal
  on public.customers (workspace_id) where is_internal;
