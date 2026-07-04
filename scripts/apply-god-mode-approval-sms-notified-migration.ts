// apply-god-mode-approval-sms-notified-migration — add
// god_mode_approvals.sms_notified_at (the 5-min nudge marker). Idempotent.
//   npx tsx scripts/apply-god-mode-approval-sms-notified-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260910130000_god_mode_approval_sms_notified.sql"];

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
        where table_schema='public' and table_name='god_mode_approvals' and column_name='sms_notified_at'`,
    );
    if (!rows.length) throw new Error("god_mode_approvals.sms_notified_at missing");
    console.log("✓ god_mode_approvals.sms_notified_at exists");
  } finally {
    await c.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
