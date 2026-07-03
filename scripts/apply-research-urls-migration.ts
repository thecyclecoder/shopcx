// apply-research-urls-migration — create public.research_urls (rhea-url-sensor Phase 1).
// Rhea's URL sensor: one row per distinct ad-scout destination, deduped by normalized URL.
// Idempotent (CREATE TABLE / TRIGGER / POLICY IF NOT EXISTS).
// Run against the pooler:
//   npx tsx scripts/apply-research-urls-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260812120000_research_urls.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: t } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='research_urls'",
    );
    console.log(`✓ research_urls table present: ${t[0].n === 1}`);
    const { rows: cols } = await c.query(
      "select column_name from information_schema.columns where table_name='research_urls' order by ordinal_position",
    );
    console.log(`✓ research_urls columns: ${cols.map((r) => r.column_name).join(", ")}`);
    const { rows: idx } = await c.query(
      "select indexname from pg_indexes where tablename='research_urls' order by indexname",
    );
    console.log(`✓ research_urls indexes: ${idx.map((r) => r.indexname).join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
