/**
 * Apply the June refund-approval threshold column (additive, idempotent).
 *   npx tsx scripts/apply-june-refund-threshold.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260710120000_june_refund_approval_threshold.sql";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8"));
    const { rows } = await c.query(
      "select column_name, data_type, column_default from information_schema.columns where table_name='workspaces' and column_name='june_refund_approval_threshold_cents'",
    );
    console.log("applied:", MIGRATION);
    console.table(rows);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
