// apply-storefront-experiments-migration — create the storefront experiment + bandit
// framework tables (storefront-experiment-bandit-framework spec, Phase 1).
// Idempotent (CREATE TABLE / INDEX / POLICY IF NOT EXISTS, drop-then-add FK). Run against the pooler:
//   npx tsx scripts/apply-storefront-experiments-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260623120000_storefront_experiments.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    for (const table of [
      "storefront_experiments",
      "storefront_experiment_variants",
      "storefront_experiment_runs",
    ]) {
      const { rows } = await c.query(
        "select count(*)::int as n from information_schema.columns where table_schema='public' and table_name=$1",
        [table],
      );
      console.log(`✓ public.${table} has ${rows[0].n} columns`);
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
