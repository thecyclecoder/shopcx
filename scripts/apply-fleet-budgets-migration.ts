// apply-fleet-budgets-migration — create public.fleet_budgets (fleet-spend-governor Phase 1).
// Per-kind / per-function spend ceilings for the box agent fleet. Idempotent
// (CREATE TABLE / INDEX / POLICY IF NOT EXISTS, ON CONFLICT DO NOTHING for the seed).
// Run against the pooler:
//   npx tsx scripts/apply-fleet-budgets-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260712120000_fleet_budgets.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: t } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='fleet_budgets'",
    );
    console.log(`✓ fleet_budgets table present: ${t[0].n === 1}`);
    const { rows: seed } = await c.query("select count(*)::int as n from public.fleet_budgets where workspace_id is null");
    console.log(`✓ fleet_budgets default seed rows: ${seed[0].n}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
