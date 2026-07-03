// apply-research-urls-teardown-migration — add public.research_urls.teardown jsonb
// (rhea-teardown-recipe Phase 1). Idempotent (ADD COLUMN IF NOT EXISTS).
// Run against the pooler:
//   npx tsx scripts/apply-research-urls-teardown-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260813120000_research_urls_teardown.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: cols } = await c.query(
      "select column_name, data_type, is_nullable from information_schema.columns where table_name='research_urls' and column_name='teardown'",
    );
    if (cols.length === 1) {
      console.log(
        `✓ research_urls.teardown present: type=${cols[0].data_type} nullable=${cols[0].is_nullable}`,
      );
    } else {
      throw new Error("research_urls.teardown column not found after migration");
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
