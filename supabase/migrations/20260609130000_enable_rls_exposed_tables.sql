-- SECURITY FIX (Supabase lint: rls_disabled_in_public)
--
-- Six public tables shipped with ROW LEVEL SECURITY DISABLED while the
-- `anon` and `authenticated` roles hold full table grants. With RLS off,
-- that means the public (anon) API key could read AND write them:
--   - auth_otp_sessions      — OTP/verification session state (account-takeover risk)
--   - klaviyo_profile_staging/directory — every customer's email, phone, name,
--                                          address, IP, lat/long, timezone (mass PII)
--   - coupons                — harvest valid codes / mint free ones
--   - sms_send_candidates    — customer phone numbers + campaign targeting
--   - migration_audits       — subscription/contract ids + charge amounts
--
-- Fix: enable RLS and add the same service-role + workspace-scoped policies
-- the other ~145 tables already use. anon gets NO policy, so RLS denies it
-- by default (the existing anon table grants become inert once RLS is on,
-- exactly like every other table in this schema). All six have workspace_id.

-- auth_otp_sessions — backend auth state only. Service role, no user read
-- (dashboard never displays raw OTP sessions; least privilege).
ALTER TABLE public.auth_otp_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_otp_sessions_service_all ON public.auth_otp_sessions;
CREATE POLICY auth_otp_sessions_service_all ON public.auth_otp_sessions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- coupons
ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS coupons_service_all ON public.coupons;
CREATE POLICY coupons_service_all ON public.coupons
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS coupons_select_own_workspace ON public.coupons;
CREATE POLICY coupons_select_own_workspace ON public.coupons
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

-- klaviyo_profile_directory
ALTER TABLE public.klaviyo_profile_directory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS klaviyo_profile_directory_service_all ON public.klaviyo_profile_directory;
CREATE POLICY klaviyo_profile_directory_service_all ON public.klaviyo_profile_directory
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS klaviyo_profile_directory_select_own_workspace ON public.klaviyo_profile_directory;
CREATE POLICY klaviyo_profile_directory_select_own_workspace ON public.klaviyo_profile_directory
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

-- klaviyo_profile_staging
ALTER TABLE public.klaviyo_profile_staging ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS klaviyo_profile_staging_service_all ON public.klaviyo_profile_staging;
CREATE POLICY klaviyo_profile_staging_service_all ON public.klaviyo_profile_staging
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS klaviyo_profile_staging_select_own_workspace ON public.klaviyo_profile_staging;
CREATE POLICY klaviyo_profile_staging_select_own_workspace ON public.klaviyo_profile_staging
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

-- migration_audits
ALTER TABLE public.migration_audits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS migration_audits_service_all ON public.migration_audits;
CREATE POLICY migration_audits_service_all ON public.migration_audits
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS migration_audits_select_own_workspace ON public.migration_audits;
CREATE POLICY migration_audits_select_own_workspace ON public.migration_audits
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

-- sms_send_candidates
ALTER TABLE public.sms_send_candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_send_candidates_service_all ON public.sms_send_candidates;
CREATE POLICY sms_send_candidates_service_all ON public.sms_send_candidates
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS sms_send_candidates_select_own_workspace ON public.sms_send_candidates;
CREATE POLICY sms_send_candidates_select_own_workspace ON public.sms_send_candidates
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
