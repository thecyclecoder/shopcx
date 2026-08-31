// apply-specs-ws-active-partial-index-migration — back list_specs_with_phases so the
// planner stops seq-scanning public.specs for the `'active'` scope (the hot caller).
//
// DB Health Agent flagged pg_stat_statements 4608471940106465663:
//   calls=79447 mean=100ms total=7969s — Seq Scan on specs s
//   (see 20260831120000_specs_ws_active_partial_index.sql for the full EXPLAIN + rationale).
//
// Runs CREATE INDEX CONCURRENTLY so it doesn't take a long lock on the hot specs table.
// CONCURRENTLY can't run inside a transaction block, so the statement is issued on its own
// (NOT the migration file, which Postgres would wrap implicitly). Idempotent via IF NOT EXISTS.
//   npx tsx scripts/apply-specs-ws-active-partial-index-migration.ts
import { pgClient } from "./_bootstrap";

const STATEMENTS = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS specs_ws_active_updated_at_idx
     ON public.specs (workspace_id, updated_at)
     WHERE (status IS NULL OR status <> 'folded')`,
];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const sql of STATEMENTS) {
      await c.query(sql);
      console.log(`✓ ${sql.trim().split("\n")[0]} …`);
    }
    const { rows } = await c.query(
      `select indexname from pg_indexes
       where tablename = 'specs'
         and indexname = 'specs_ws_active_updated_at_idx'`,
    );
    console.log("✓ present:", rows.map((r) => r.indexname));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
