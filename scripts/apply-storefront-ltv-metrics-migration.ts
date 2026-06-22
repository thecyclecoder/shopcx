// apply-storefront-ltv-metrics-migration — create storefront_ltv_metrics, the fast-loop
// predicted-LTV-per-visitor reward table (storefront-ltv-proxy-reconciler spec, Phase 2).
// Idempotent (CREATE TABLE / INDEX / POLICY IF NOT EXISTS). Run against the pooler:
//   npx tsx scripts/apply-storefront-ltv-metrics-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260625120000_storefront_ltv_metrics.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    for (const table of ["storefront_ltv_metrics"]) {
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
