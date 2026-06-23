// apply-control-tower-loop-registry-migration — create public.control_tower_loop_registry
// (control-tower-registered-not-firing-new-cron-grace spec): per-loop first_observed_at anchor for
// the registered_not_firing grace window. Idempotent (CREATE TABLE / POLICY IF NOT EXISTS / drop+create).
// Run against the pooler:
//   npx tsx scripts/apply-control-tower-loop-registry-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260629120000_control_tower_loop_registry.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='control_tower_loop_registry'",
    );
    console.log(`✓ control_tower_loop_registry table present: ${rows[0].n === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
