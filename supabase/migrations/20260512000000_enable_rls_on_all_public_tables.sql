-- Supabase flagged tables in `public` without RLS enabled (May 3 alert).
-- Enable RLS on every table in `public` that doesn't have it yet, and
-- add a service_role ALL policy so our backend (admin client) keeps
-- working unchanged. authenticated/anon access stays denied by default —
-- tables that need broader access already have their own policies.
--
-- service_role bypasses RLS anyway, but adding the explicit policy
-- protects against any future change that strips service_role's
-- BYPASSRLS attribute.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND rowsecurity = false
    ORDER BY tablename
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.schemaname, r.tablename);
    RAISE NOTICE 'Enabled RLS on %.%', r.schemaname, r.tablename;

    -- Add service_role policy if one doesn't already exist for ALL ops.
    -- We name policies "<tablename>_service_role" so they're idempotent
    -- across runs.
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = r.schemaname
        AND tablename = r.tablename
        AND policyname = format('%s_service_role', r.tablename)
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        format('%s_service_role', r.tablename),
        r.schemaname,
        r.tablename
      );
    END IF;
  END LOOP;
END $$;
