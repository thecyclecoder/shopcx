-- Enable RLS on the 3 public tables flagged CRITICAL by the Supabase security advisor
-- (rls_disabled_in_public ×3 + sensitive_columns_exposed on ad_breakdowns.treatment).
--
-- All three are accessed ONLY through createAdminClient() (service_role), which BYPASSES RLS,
-- so enabling RLS with NO policy denies anonymous/authenticated PostgREST access while leaving
-- every server-side (service-role) read/write untouched. Verified 2026-07-14: no client-side
-- (browser) or anon-key server-client reader of any of these tables exists in src/.
--
-- Before this migration an anonymous request bearing only the public anon key could read:
--   competitor_ads (163 rows), agent_action_requests (18 rows), ad_breakdowns (0 rows).
-- After: all three return permission-filtered empty results to anon, matching the other 294
-- public tables that already have RLS enabled.

ALTER TABLE public.agent_action_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competitor_ads         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_breakdowns          ENABLE ROW LEVEL SECURITY;
