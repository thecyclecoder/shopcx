// apply-function-autonomy-migration — create public.function_autonomy (approval-routing-engine
// Phase 1: the per-function live+autonomous flag the org-chart approval router reads). Idempotent
// (CREATE TABLE IF NOT EXISTS + seed ON CONFLICT DO NOTHING). Run against the pooler:
//   npx tsx scripts/apply-function-autonomy-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260701120000_function_autonomy.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='function_autonomy'",
    );
    console.log(`✓ function_autonomy table present: ${rows[0].n === 1}`);
    const { rows: seed } = await c.query("select count(*)::int as n from public.function_autonomy");
    console.log(`✓ function_autonomy seeded rows: ${seed[0].n}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
