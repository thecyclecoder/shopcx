// apply-worker-coaching-migration — create public.worker_instructions + public.worker_coaching_log
// (worker-coaching-loop Phase 1: the DevOps Director's per-worker versioned guidance store + the
// director→worker coaching log). Idempotent (CREATE TABLE / INDEX IF NOT EXISTS · DROP/CREATE POLICY).
// Run against the pooler:
//   npx tsx scripts/apply-worker-coaching-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260703120000_worker_coaching.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name in ('worker_instructions','worker_coaching_log')",
    );
    console.log(`✓ worker-coaching tables present: ${rows[0].n === 2} (${rows[0].n}/2)`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
