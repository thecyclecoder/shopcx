// apply-kill-switches-migration — create public.kill_switches
// ([[kill-switches-table-and-cascade-resolver]] Phase 1: the universal on/off primitive
// behind the CEO control-tower switch). Idempotent (CREATE TABLE IF NOT EXISTS, seeded
// empty on purpose). Run against the pooler:
//   npx tsx scripts/apply-kill-switches-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261013000000_kill_switches.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='kill_switches'",
    );
    console.log(`✓ kill_switches table present: ${rows[0].n === 1}`);
    const { rows: seed } = await c.query("select count(*)::int as n from public.kill_switches");
    console.log(`✓ kill_switches seeded rows (expect 0 — fail-open default): ${seed[0].n}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
