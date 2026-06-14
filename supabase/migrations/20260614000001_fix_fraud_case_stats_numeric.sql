-- Fix fraud_case_stats: column 4 (value_at_risk_cents) is declared BIGINT but
-- COALESCE(SUM(...), 0) returns NUMERIC in Postgres (SUM over bigint widens to
-- numeric), so the RPC failed on every call with:
--   "structure of query does not match function result type"
--   "Returned type numeric does not match expected type bigint in column 4".
-- The COUNT(*) columns are fine (COUNT returns bigint). Cast column 4 to bigint.

CREATE OR REPLACE FUNCTION public.fraud_case_stats(p_workspace_id UUID)
RETURNS TABLE (
  open_count BIGINT,
  confirmed_30d BIGINT,
  dismissed_30d BIGINT,
  value_at_risk_cents BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*) FILTER (WHERE fc.status = 'open') AS open_count,
    COUNT(*) FILTER (WHERE fc.status = 'confirmed_fraud' AND fc.reviewed_at >= now() - interval '30 days') AS confirmed_30d,
    COUNT(*) FILTER (WHERE fc.status = 'dismissed' AND fc.reviewed_at >= now() - interval '30 days') AS dismissed_30d,
    COALESCE(SUM(
      CASE WHEN fc.status IN ('open', 'reviewing') THEN
        COALESCE((fc.evidence->>'total_order_value_cents')::bigint, (fc.evidence->>'total_spend_in_window_cents')::bigint, 0)
      ELSE 0 END
    ), 0)::bigint AS value_at_risk_cents
  FROM public.fraud_cases fc
  WHERE fc.workspace_id = p_workspace_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
