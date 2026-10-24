-- Close the SECURITY DEFINER exposure on public.insert_coupon_on_conflict_ignore.
--
-- That conflict-tolerant loyalty-coupon materialize RPC
-- (added in commit d0888732, migration 20261024150000) is SECURITY DEFINER but
-- only GRANTed EXECUTE to service_role — it never REVOKEd the Postgres default
-- PUBLIC grant. That left it callable by Supabase's anon/authenticated roles via
-- PostgREST /rest/v1/rpc/, where — because SECURITY DEFINER runs with the owner's
-- privileges — it bypasses RLS on public.coupons and lets any caller mint
-- arbitrary-value fixed_amount coupons for any workspace/customer.
--
-- Revoke the default PUBLIC (plus the explicit anon/authenticated) execute and
-- (idempotently re-)grant EXECUTE only to service_role, which is the role the
-- service-role admin client (src/lib/coupons.ts
-- insertInternalLoyaltyCouponRowUnchecked) already runs as — so the legitimate
-- materialize path is unaffected. Mirrors the revoke-then-grant pattern in
-- 20260925120001_get_user_id_by_email.sql. Idempotent: REVOKE/GRANT are
-- no-ops when the grant state already matches.

revoke execute on function public.insert_coupon_on_conflict_ignore(
  UUID, TEXT, TEXT, INTEGER, TEXT, INTEGER, UUID, BOOLEAN
) from public;

revoke execute on function public.insert_coupon_on_conflict_ignore(
  UUID, TEXT, TEXT, INTEGER, TEXT, INTEGER, UUID, BOOLEAN
) from anon;

revoke execute on function public.insert_coupon_on_conflict_ignore(
  UUID, TEXT, TEXT, INTEGER, TEXT, INTEGER, UUID, BOOLEAN
) from authenticated;

grant execute on function public.insert_coupon_on_conflict_ignore(
  UUID, TEXT, TEXT, INTEGER, TEXT, INTEGER, UUID, BOOLEAN
) to service_role;
