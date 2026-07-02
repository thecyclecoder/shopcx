// apply-pm-structured-refs-migration — create public.spec_brain_refs + add specs.parent_kind /
// specs.parent_ref (pm-structured-intent-and-refs Phase 2). Idempotent (IF NOT EXISTS / ADD COLUMN
// IF NOT EXISTS).
// Run against the pooler:
//   npx tsx scripts/apply-pm-structured-refs-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260807150000_pm_structured_refs_and_typed_parent.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: t } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='spec_brain_refs'",
    );
    console.log(`✓ spec_brain_refs table present: ${t[0].n === 1}`);
    const { rows: cols } = await c.query(
      "select column_name from information_schema.columns where table_name='specs' and column_name in ('parent_kind','parent_ref') order by column_name",
    );
    console.log(`✓ specs typed-parent columns: ${cols.map((r) => r.column_name).join(", ") || "(none)"}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
