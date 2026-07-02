// apply-lander-snapshots-funnel-migration — add funnel-follow columns to lander_snapshots
// (docs/brain/specs/funnel-teardown-scout.md, Phase 1):
//   funnel_step int (0 = entry), cta_target_url text, funnel_root_url text.
// Idempotent (ADD COLUMN IF NOT EXISTS). Run via:
//   npx tsx scripts/apply-lander-snapshots-funnel-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260809120000_lander_snapshots_funnel_columns.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      `select column_name from information_schema.columns
       where table_name = 'lander_snapshots'
         and column_name in ('funnel_step','cta_target_url','funnel_root_url')
       order by column_name`,
    );
    console.log("✓ columns present:", rows.map((r) => r.column_name));
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
