// apply-adlibrary-searches-migration — create public.adlibrary_searches
// (adlibrary-search-freshness-gate Phase 1). Per-(workspace, keyword) last-searched
// ledger the Phase 2 freshness gate reads to skip already-fresh seeds. Idempotent
// (CREATE TABLE / TRIGGER / POLICY IF NOT EXISTS).
// Run against the pooler:
//   npx tsx scripts/apply-adlibrary-searches-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260810120000_adlibrary_searches.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: t } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='adlibrary_searches'",
    );
    console.log(`✓ adlibrary_searches table present: ${t[0].n === 1}`);
    const { rows: cols } = await c.query(
      "select column_name from information_schema.columns where table_name='adlibrary_searches' order by ordinal_position",
    );
    console.log(`✓ adlibrary_searches columns: ${cols.map((r) => r.column_name).join(", ")}`);
    const { rows: uq } = await c.query(
      `select conname from pg_constraint where conrelid = 'public.adlibrary_searches'::regclass and contype = 'u'`,
    );
    console.log(`✓ unique constraints: ${uq.map((r) => r.conname).join(", ")}`);
    const { rows: idx } = await c.query(
      `select indexname from pg_indexes where schemaname='public' and tablename='adlibrary_searches' order by indexname`,
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
