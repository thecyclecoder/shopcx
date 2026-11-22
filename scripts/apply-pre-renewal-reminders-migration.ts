// apply-pre-renewal-reminders-migration — create public.pre_renewal_reminders, the
// send-ledger for the pre-renewal reminder channel ([[pre-renewal-reminder-sends]] Phase 1).
// Idempotent (CREATE TABLE IF NOT EXISTS, RLS policy drop-then-create). Run against the pooler:
//   npx tsx scripts/apply-pre-renewal-reminders-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20270122120000_pre_renewal_reminders.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name=$1",
      ["pre_renewal_reminders"],
    );
    console.log(`✓ pre_renewal_reminders table present: ${rows[0].n === 1}`);
    // Prove the idempotency guard exists: unique (workspace_id, group_id, renewal_window_key).
    const { rows: uniq } = await c.query(
      `select count(*)::int as n from pg_indexes
         where tablename='pre_renewal_reminders'
           and indexdef ilike '%unique%group_id%renewal_window_key%'`,
    );
    console.log(`✓ unique (workspace_id, group_id, renewal_window_key) guard present: ${uniq[0].n >= 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
