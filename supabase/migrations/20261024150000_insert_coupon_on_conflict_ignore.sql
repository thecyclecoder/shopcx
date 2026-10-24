-- Conflict-tolerant internal-coupon insert.
--
-- The loyalty-coupon materializer (src/lib/coupons.ts
-- insertInternalLoyaltyCouponRowUnchecked) deliberately relies on the
-- coupons_workspace_code_idx unique index to arbitrate a concurrency race:
-- when two coupon-apply paths materialize the SAME loyalty code at the same
-- time, one wins the insert and the loser re-reads the winner's row. That is
-- correct and already recovers gracefully — but the losing bare INSERT trips
-- the unique index, so Postgres logs a unique-violation ERROR on every race.
-- Those errors are harmless to customers yet surface as an open Control Tower
-- signature (supabase-logs:bbd5f21ef9289c31), creating triage noise for a loop
-- that is actually healthy.
--
-- This SECURITY DEFINER function performs the same insert idempotently:
-- ON CONFLICT (workspace_id, lower(code)) DO NOTHING RETURNING id. The loser
-- now gets zero rows back (null id) instead of raising — no ERROR is logged —
-- and the caller's existing readExisting() fallback resolves the winner's row.
CREATE OR REPLACE FUNCTION public.insert_coupon_on_conflict_ignore(
  p_workspace_id UUID,
  p_code TEXT,
  p_type TEXT,
  p_value INTEGER,
  p_scope TEXT,
  p_recurring_cycle_limit INTEGER,
  p_customer_id UUID,
  p_single_use BOOLEAN
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO public.coupons (
    workspace_id,
    code,
    type,
    value,
    scope,
    recurring_cycle_limit,
    customer_id,
    single_use
  )
  VALUES (
    p_workspace_id,
    p_code,
    p_type,
    p_value,
    p_scope,
    p_recurring_cycle_limit,
    p_customer_id,
    p_single_use
  )
  ON CONFLICT (workspace_id, lower(code)) DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id; -- null when the row already existed (the conflict/loser case)
END;
$$;

GRANT EXECUTE ON FUNCTION public.insert_coupon_on_conflict_ignore(
  UUID, TEXT, TEXT, INTEGER, TEXT, INTEGER, UUID, BOOLEAN
) TO service_role;
