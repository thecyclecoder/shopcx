// apply-specs-regression-columns-migration — add public.specs.regression_of_slug + .regression_signature
// (spec-authoring-writes-db-and-worker-materialize Phase 1). Idempotent (ADD COLUMN IF NOT EXISTS).
// Run against the pooler:
//   npx tsx scripts/apply-specs-regression-columns-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260725120000_specs_regression_columns.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: cols } = await c.query(
      `select column_name, data_type from information_schema.columns
        where table_schema='public' and table_name='specs'
          and column_name in ('regression_of_slug','regression_signature')
        order by column_name`,
    );
    console.log(`✓ specs columns present: ${cols.map((r) => `${r.column_name}(${r.data_type})`).join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
