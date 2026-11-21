// apply-customer-lifecycle-experiments-migration — create the person-level experiment spine:
// public.customer_lifecycle_experiments + public.customer_lifecycle_experiment_assignments
// ([[subscriber-experiment-harness]] Phase 1). Idempotent (CREATE TABLE IF NOT EXISTS, RLS
// policies drop-then-create). Run against the pooler:
//   npx tsx scripts/apply-customer-lifecycle-experiments-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20270121120000_customer_lifecycle_experiments.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    for (const t of [
      "customer_lifecycle_experiments",
      "customer_lifecycle_experiment_assignments",
    ]) {
      const { rows } = await c.query(
        "select count(*)::int as n from information_schema.tables where table_name=$1",
        [t],
      );
      console.log(`✓ ${t} table present: ${rows[0].n === 1}`);
    }
    // Prove the sticky-assignment guard exists: unique (experiment_id, group_id).
    const { rows: uniq } = await c.query(
      `select count(*)::int as n from pg_indexes
         where tablename='customer_lifecycle_experiment_assignments'
           and indexdef ilike '%unique%experiment_id%group_id%'`,
    );
    console.log(`✓ unique (experiment_id, group_id) constraint present: ${uniq[0].n >= 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
