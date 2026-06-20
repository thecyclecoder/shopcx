/**
 * Apply the comp-subscriptions migration (comp_role enum + comp_note on customers;
 * comp + comp_note on subscriptions; partial indexes). Idempotent. Gated prod write.
 * Run: npx tsx scripts/apply-comp-subscriptions-migration.ts
 * See docs/brain/specs/comp-subscriptions.md.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const migrationPath = resolve(__dirname, "../supabase/migrations/20260620190000_comp_subscriptions.sql");
const sql = readFileSync(migrationPath, "utf8");

async function main() {
  const client = pgClient();
  await client.connect();
  try {
    await client.query(sql);
    console.log("✓ Applied 20260620190000_comp_subscriptions.sql");
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
