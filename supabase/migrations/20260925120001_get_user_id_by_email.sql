-- Targeted email → auth.users.id lookup so the hot-path auth check
-- (src/lib/access.ts :: isAuthorizedUser) can avoid a full-table
-- listUsers() scan and use getUserById() on a specific id instead.
--
-- SECURITY DEFINER so callers (service_role) don't need direct SELECT
-- on auth.users. Locked-down search_path prevents search_path attacks.

create or replace function public.get_user_id_by_email(p_email text)
returns uuid
language sql
security definer
stable
set search_path = auth, pg_temp
as $$
  select id
  from auth.users
  where lower(email) = lower(p_email)
  limit 1;
$$;

revoke execute on function public.get_user_id_by_email(text) from public;
revoke execute on function public.get_user_id_by_email(text) from anon;
revoke execute on function public.get_user_id_by_email(text) from authenticated;
grant execute on function public.get_user_id_by_email(text) to service_role;
