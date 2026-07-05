-- loyalty_program_stats — program-wide loyalty aggregate for the /dashboard/loyalty header cards
-- (docs/brain/specs/loyalty-list-stats-and-adjust-guard.md Phase 1). Replaces a 250-row client-side
-- sample sum in src/app/dashboard/loyalty/page.tsx that was labeled program-wide but wrong for any
-- workspace with >250 loyalty_members. Reads all loyalty_members for the workspace and returns the
-- true SUM(points_balance), SUM(points_earned), COUNT(*), and integer AVG(points_balance) — the
-- avg's denominator is the true member count, not the sample size.

CREATE OR REPLACE FUNCTION public.loyalty_program_stats(p_workspace_id UUID)
RETURNS TABLE (
  total_members BIGINT,
  total_points BIGINT,
  total_earned BIGINT,
  avg_points BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT AS total_members,
    COALESCE(SUM(lm.points_balance), 0)::BIGINT AS total_points,
    COALESCE(SUM(lm.points_earned), 0)::BIGINT AS total_earned,
    COALESCE(ROUND(AVG(lm.points_balance))::BIGINT, 0) AS avg_points
  FROM public.loyalty_members lm
  WHERE lm.workspace_id = p_workspace_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
