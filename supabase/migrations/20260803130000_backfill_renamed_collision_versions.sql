-- Backfill supabase_migrations.schema_migrations rows for the 2 files renamed out of
-- collision clusters in this PR (predeploy-guards-actually-run-on-every-build Phase 1(c)).
-- The colliding siblings (alphabetically-later of each cluster) were renamed with
--   git mv <version>_<slug>.sql <version+1>_<slug>.sql
-- Without a paired schema_migrations row for the new version, the migration-drift reconciler
-- (src/lib/control-tower/migration-drift.ts computeMergedButUnapplied) would spuriously flag
-- the renamed file as merged-but-unapplied on the next tick and attempt to re-apply DDL that
-- is already live in prod — verified 2026-08-02: all four columns (goals.is_parent,
-- crisis_customer_actions.restored_at, orders.amplifier_import_attempts,
-- iteration_policies.slow_kill_min_spend_cents) are present.
--
-- Idempotent by design — same pattern as 20260720120000_backfill_renamed_collision_versions.sql:
-- (a) ON CONFLICT (version) DO NOTHING so a concurrent apply that beat us to inserting the row
-- is a no-op; (b) the DO block tries two column shapes — (version, name) first, falling back
-- to (version)-only — so Supabase revisions with a NOT NULL on `name` and revisions with the
-- minimal shape both work.
--
-- READ-ONLY as far as the public schema is concerned — this migration touches ONLY
-- supabase_migrations.schema_migrations and inserts NO DDL.

do $mig$
begin
  begin
    insert into supabase_migrations.schema_migrations (version, name) values
      ('20260729120001', '20260729120001_goals_is_parent'),
      ('20261205120001', '20261205120001_iteration_policies_slow_kill_knobs')
      on conflict (version) do nothing;
  exception when others then
    insert into supabase_migrations.schema_migrations (version) values
      ('20260729120001'),
      ('20261205120001')
      on conflict (version) do nothing;
  end;
end
$mig$;
