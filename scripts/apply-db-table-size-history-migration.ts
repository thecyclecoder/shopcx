// apply-db-table-size-history-migration — create the DB Health Agent's daily size-snapshot store
// (docs/brain/specs/db-health-agent.md, Phase 1):
//   db_table_size_history — one row per public table per daily sweep: total/table/index bytes,
//                           planner row estimate, seq_scan/idx_scan counters, and the dead-tuple
//                           + last-vacuum bloat signal. Backs the growth-rate + index/bloat checks.
// Idempotent (CREATE TABLE / INDEX / POLICY IF NOT EXISTS). Run against the pooler:
//   npx tsx scripts/apply-db-table-size-history-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260629120000_db_table_size_history.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.columns where table_schema='public' and table_name=$1",
      ["db_table_size_history"],
    );
    console.log(`✓ public.db_table_size_history has ${rows[0].n} columns`);
    const { rows: idx } = await c.query(
      "select indexname from pg_indexes where schemaname='public' and tablename='db_table_size_history' order by indexname",
    );
    console.log(`✓ indexes: ${idx.map((r) => r.indexname).join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
