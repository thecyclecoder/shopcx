// apply-research-urls-growth-reviewed-at-migration — add public.research_urls.growth_reviewed_at
// timestamptz null + a partial index matching the listNewTeardowns query shape
// (rhea-research-automation Phase 3 — the Cleo handoff watermark). Idempotent.
// Run against the pooler:
//   npx tsx scripts/apply-research-urls-growth-reviewed-at-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260815120000_research_urls_growth_reviewed_at.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: cols } = await c.query(
      `select column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema='public'
          and table_name='research_urls'
          and column_name='growth_reviewed_at'`,
    );
    if (cols.length !== 1) throw new Error("research_urls.growth_reviewed_at column missing after migration");
    console.log(
      `✓ research_urls.growth_reviewed_at present: type=${cols[0].data_type} nullable=${cols[0].is_nullable}`,
    );
    const { rows: idx } = await c.query(
      `select indexname from pg_indexes
        where schemaname='public' and tablename='research_urls'
          and indexname='research_urls_growth_unreviewed_idx'`,
    );
    if (idx.length !== 1) throw new Error("partial index research_urls_growth_unreviewed_idx missing after migration");
    console.log(`✓ partial index research_urls_growth_unreviewed_idx present`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
