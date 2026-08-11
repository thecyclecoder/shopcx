/**
 * One-time ledger-reconcile safety net for retired migration `20261124120000_creative_skeletons_wireframe.sql`.
 *
 * That file's DDL was rejected by Postgres — a subquery inside a CHECK constraint ("cannot use
 * subquery in check constraint") — so it never actually applied. The columns exist today because
 * they were applied manually column-only on 2026-07-22, and `20261130120001_creative_skeletons_wireframe_shape_trigger.sql`
 * delivered the shape validation via a BEFORE INSERT/UPDATE trigger (the correct home for this
 * check).
 *
 * Phase 1 of reconcile-migration-drift-2026-08-superseded-and-check-superset:
 * the broken .sql file has been DELETED from the tree, so the migration-drift reconciler's
 * `mergedButUnapplied` slice will drop the version on the next tick (the version is no longer
 * on-main). This script is the SAFETY NET for any stale worktree (a build box that hasn't yet
 * seen the deletion commit) that would otherwise try to re-attempt the broken DDL: it records
 * version `20261124120000` in `supabase_migrations.schema_migrations` with ON CONFLICT DO NOTHING,
 * so a stale worktree's reconciler classifies it as already-applied and skips it.
 *
 * Idempotent by construction:
 *   • ON CONFLICT (version) DO NOTHING — a second run inserts nothing.
 *   • Multi-shape fallback for the ledger row (three insert attempts against different column
 *     shapes, each in its own SAVEPOINT) mirrors `scripts/_reconcile-migration-ledger.ts`
 *     `recordVersion` — the target Supabase schema revision may or may not carry the
 *     `name` / `statements` columns.
 *
 * Auto-tracked by [[../src/lib/ship-time-backfill-detector.ts]] `detectAndEscalateShipTimeBackfills`
 * (regex extended in this phase to accept `scripts/_ledger-reconcile-*.ts` alongside
 * `scripts/_backfill-*.ts`) and drained by `executeShipTimeBackfillsForSpec` in
 * `src/lib/ship-time-backfill-executor.ts` — the CLAUDE.md ship-time-backfill-must-be-tracked
 * convention. A never-run reconcile escalates to the CEO inbox; the executor flips the row to
 * `ran` on exit 0.
 *
 * Follows the write-a-migration-apply-script recipe: pooler connection via `poolerConnectionString`
 * on the `:6543` transaction pooler, connect → query → end.
 *
 * Usage:
 *   npx tsx scripts/_ledger-reconcile-20261124120000.ts
 */
import { errText } from "../src/lib/error-text";
import { pgClient } from "./_bootstrap";

const VERSION = "20261124120000";
const NAME_WITHOUT_EXT = "20261124120000_creative_skeletons_wireframe";

async function recordVersion(c: import("pg").Client): Promise<void> {
  const attempts: Array<{ sql: string; params: unknown[] }> = [
    {
      sql: `insert into supabase_migrations.schema_migrations (version, name, statements)
            values ($1, $2, array[$3]::text[])
            on conflict (version) do nothing`,
      params: [VERSION, NAME_WITHOUT_EXT, "-- retired: superseded by 20261130120001_creative_skeletons_wireframe_shape_trigger.sql"],
    },
    {
      sql: `insert into supabase_migrations.schema_migrations (version, name)
            values ($1, $2)
            on conflict (version) do nothing`,
      params: [VERSION, NAME_WITHOUT_EXT],
    },
    {
      sql: `insert into supabase_migrations.schema_migrations (version)
            values ($1)
            on conflict (version) do nothing`,
      params: [VERSION],
    },
  ];
  const savepointName = `rec_${VERSION}`;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    await c.query(`SAVEPOINT ${savepointName}`);
    try {
      await c.query(a.sql, a.params);
      await c.query(`RELEASE SAVEPOINT ${savepointName}`);
      return;
    } catch (err) {
      await c.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      await c.query(`RELEASE SAVEPOINT ${savepointName}`);
      if (i === attempts.length - 1) throw err;
    }
  }
}

async function main(): Promise<void> {
  console.log(`[ledger-reconcile-${VERSION}] recording version in supabase_migrations.schema_migrations (ON CONFLICT DO NOTHING)`);
  const c = pgClient();
  await c.connect();
  try {
    await c.query("BEGIN");
    try {
      await recordVersion(c);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    }
    console.log(`[ledger-reconcile-${VERSION}] done — version is present in the ledger (idempotent).`);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(`[ledger-reconcile-${VERSION}] failed: ${errText(e)}`);
  process.exit(1);
});
