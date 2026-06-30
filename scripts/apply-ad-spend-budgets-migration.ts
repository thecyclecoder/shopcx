// apply-ad-spend-budgets-migration — create public.ad_spend_budgets (growth-ad-spend-rail Phase 1).
// Per-workspace ad-DOLLAR budget ceilings for the Growth director. Idempotent
// (CREATE TABLE / TRIGGER / POLICY IF NOT EXISTS).
// Run against the pooler:
//   npx tsx scripts/apply-ad-spend-budgets-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260803120000_ad_spend_budgets.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: t } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='ad_spend_budgets'",
    );
    console.log(`✓ ad_spend_budgets table present: ${t[0].n === 1}`);
    const { rows: cols } = await c.query(
      "select column_name from information_schema.columns where table_name='ad_spend_budgets' order by ordinal_position",
    );
    console.log(`✓ ad_spend_budgets columns: ${cols.map((r) => r.column_name).join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
