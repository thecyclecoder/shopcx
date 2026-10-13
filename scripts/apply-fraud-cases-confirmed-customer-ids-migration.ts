// apply-fraud-cases-confirmed-customer-ids-migration — add fraud_cases.confirmed_customer_ids
// (docs/brain/specs/fraud-bin-velocity-requires-real-cross-account-link.md, Phase 3): the
// per-customer confirmation record so confirming fraud acts on exactly one customer at a time.
// Idempotent (ADD COLUMN IF NOT EXISTS + behavior-preserving backfill).
//   npx tsx scripts/apply-fraud-cases-confirmed-customer-ids-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20270107120000_fraud_cases_confirmed_customer_ids.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select column_name, data_type from information_schema.columns where table_name = 'fraud_cases' and column_name = 'confirmed_customer_ids'",
    );
    console.log("✓ column present:", rows);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
