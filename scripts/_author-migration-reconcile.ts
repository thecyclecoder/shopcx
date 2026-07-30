import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "migration-drift-reconciler-idempotent-on-already-applied-objects",
    {
      why: "The migration-drift reconciler retries 103 merged-but-unrecorded migrations every tick, producing a steady stream of Postgres errors (relation already exists, cannot change return type of existing function). Those 103 of 647 migration files have their DDL already applied to the database — the objects exist — but their versions were never recorded in supabase_migrations.schema_migrations. The reconciler classifies each as merged-but-unapplied and, for additive ones, re-runs the DDL, which throws a duplicate-object error; it records that as apply-failed and retries on the next poll. The earlier forward-only apply fix corrected the apply METHOD but never reconciled this pre-existing ledger gap or taught the reconciler that a duplicate-object error means already-applied, not failed.",
      what: "Make the reconciler's auto-apply idempotent — a duplicate-object-class Postgres error (the object already exists) records the migration version as applied instead of apply-failed — and run a one-time reconcile that clears the 103-version ledger backlog, stopping the recurring error loop.",
      summary: "In src/lib/control-tower/migration-drift.ts applyMergedMigrations/applyMigration, catch duplicate-object SQLSTATEs (42P07 duplicate_table, 42710 duplicate_object, 42723 duplicate_function, 42P06 duplicate_schema, 42701 duplicate_column, 42P13 cannot-change-return-type) during additive auto-apply and treat them as already-applied → insert the version row (the existing applyMigrationAndRecord already does ON CONFLICT DO NOTHING for the record). Add a one-time reconcile script for the current 103 merged-but-unrecorded versions.",
      title: "Migration-drift reconciler: treat 'object already exists' as already-applied (record the version), and reconcile the 103-version ledger backlog",
      owner: "platform",
      parent: '[[../functions/platform]] — "Infra & DevOps / reliability" mandate: the migration ledger being 103 versions behind makes the drift reconciler hammer the DB with duplicate-object errors every tick; reconciling it removes recurring error noise and the false-red drift tile. See [[../libraries/control-tower]] and [[../recipes/write-a-migration-apply-script]].',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — A duplicate-object error during auto-apply means already-applied, not apply-failed",
          why: "The reconciler re-runs additive migrations whose objects already exist and records apply-failed, so it retries forever and floods the log with duplicate-object errors.",
          what: "Distinguish duplicate-object SQLSTATEs from genuine failures: on a duplicate-object error, record the version as applied; keep genuine errors (syntax, undefined object) as apply-failed/gated.",
          body: "In src/lib/control-tower/migration-drift.ts, in the additive auto-apply path (applyMigration ~483 / applyMergedMigrations ~514), wrap the DDL execution so that when it throws a Postgres error whose SQLSTATE code is a duplicate-object class — 42P07 (duplicate_table), 42710 (duplicate_object), 42723 (duplicate_function), 42P06 (duplicate_schema), 42701 (duplicate_column), 42P13 (cannot_change_return_type, i.e. the function already exists) — treat the migration as ALREADY-APPLIED: record its version in supabase_migrations.schema_migrations (the existing insert uses ON CONFLICT (version) DO NOTHING) and set the outcome to a new 'reconciled'/'already-applied' status rather than 'apply-failed'. A REAL error (42601 syntax_error, 42P01 undefined_table, 42703 undefined_column, or any non-duplicate class) must still be 'apply-failed' and stay red — do NOT silently record those. Add a small exported helper isDuplicateObjectError(err) that reads err.code so the classification is one place + unit-testable. Update docs/brain/libraries/control-tower.md (migration-drift reconciler) per CLAUDE.md.",
          verification: "- tsc clean\n- the duplicate-object SQLSTATE classifier exists\n- unit test covers duplicate-object → recorded vs syntax-error → apply-failed",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "the duplicate-object classifier exists", kind: "auto", exec_kind: "grep", params: { pattern: "isDuplicateObjectError", path: "src/lib/control-tower/migration-drift.ts", expect: "present" } },
            { position: 3, description: "duplicate-object SQLSTATE codes are handled", kind: "auto", exec_kind: "grep", params: { pattern: "42P07", path: "src/lib/control-tower/migration-drift.ts", expect: "present" } },
            { position: 4, description: "migration-drift unit tests pass", kind: "auto", exec_kind: "unit_test", params: { script: "test:migration-drift" } },
          ],
          status: "planned",
        },
        {
          title: "Phase 2 — One-time reconcile of the 103 merged-but-unrecorded versions",
          why: "The current ledger is 103 versions behind, so the reconciler keeps retrying them until the backlog is cleared once.",
          what: "Run a one-time reconcile that records the already-applied versions and leaves genuinely-unapplied ones to normal handling.",
          body: "Add scripts/_reconcile-migration-ledger.ts (a `_` throwaway) that, via the pooler pgClient (SUPABASE_DB_PASSWORD, poolerConnectionString from _bootstrap), compares supabase/migrations/*.sql versions against supabase_migrations.schema_migrations, and for each merged-but-unrecorded version attempts to apply it inside a SAVEPOINT: if it succeeds it was genuinely unapplied (leave it applied + recorded); if it throws a duplicate-object-class error (per Phase 1's isDuplicateObjectError) roll back the savepoint and record the version as applied (it was already there); if it throws a genuine error, log it and SKIP (leave unrecorded for human review — do not force-record a broken migration). Print a summary: recorded-as-already-applied vs genuinely-applied vs skipped-broken. This clears the drift tile and stops the reconciler's retry loop. Verify afterward that the merged-but-unrecorded count dropped toward 0. Note the reconcile in docs/brain/libraries/control-tower.md per CLAUDE.md.",
          verification: "- tsc clean\n- the reconcile script exists and guards genuine errors (no force-record of a broken migration)",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "reconcile script present", kind: "auto", exec_kind: "grep", params: { pattern: "schema_migrations", path: "scripts/_reconcile-migration-ledger.ts", expect: "present" } },
            { position: 3, description: "reconcile uses a savepoint so a genuine error doesn't force-record", kind: "auto", exec_kind: "grep", params: { pattern: "savepoint", path: "scripts/_reconcile-migration-ledger.ts", expect: "present" } },
          ],
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "platform#infra-devops-reliability" },
  );
  console.log(ok ? "authored" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e).slice(0, 500)); process.exit(1); });
