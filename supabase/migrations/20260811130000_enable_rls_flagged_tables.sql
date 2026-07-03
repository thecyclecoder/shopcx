-- Enable RLS on three public tables Supabase's Security Advisor flagged as
-- "RLS Disabled in Public" (Jul 3 alert): coupon_redemptions, checkout_errors,
-- director_directives. All three were created AFTER the catch-all backstop
-- (20260512000000_enable_rls_on_all_public_tables.sql) and so slipped through.
--
-- Each is backend-only: writes go through createAdminClient() (service role) and
-- reads happen through owner-gated API routes, never the anon/authenticated
-- client directly. So the fix mirrors the backstop: ENABLE ROW LEVEL SECURITY
-- (which denies anon/authenticated by default) plus an explicit service_role ALL
-- policy so the admin client keeps working — and stays working even if a future
-- change ever strips service_role's BYPASSRLS attribute.
--
-- Written as literal per-table statements (not a dynamic loop) so the
-- _check-rls-on-new-tables.ts CI guard sees them and so the intent is obvious.
-- Idempotent: ENABLE RLS is a no-op if already on; policies are drop-then-create.

alter table public.coupon_redemptions enable row level security;
drop policy if exists coupon_redemptions_service_role on public.coupon_redemptions;
create policy coupon_redemptions_service_role on public.coupon_redemptions
  for all to service_role using (true) with check (true);

alter table public.checkout_errors enable row level security;
drop policy if exists checkout_errors_service_role on public.checkout_errors;
create policy checkout_errors_service_role on public.checkout_errors
  for all to service_role using (true) with check (true);

alter table public.director_directives enable row level security;
drop policy if exists director_directives_service_role on public.director_directives;
create policy director_directives_service_role on public.director_directives
  for all to service_role using (true) with check (true);
