// apply-sms-campaign-delivered-counter-migration — Phase 4 of twilio-callback-queue-drain.
// Adds:
//   - sms_campaigns.recipients_delivered (aggregate counter, recounted by the drain)
//   - sms_campaign_recipients.received_sms_logged_at (idempotency flag for the
//     new watermarked Received-SMS profile-event rollup cron)
//   - idx_sms_campaign_recipients_rollup_pending (partial index over the
//     un-rolled-up candidate set so the rollup scan is bounded)
//
// Idempotent (IF NOT EXISTS on both columns + the index) so re-running is safe.
//   npx tsx scripts/apply-sms-campaign-delivered-counter-migration.ts
import { pgClient } from "./_bootstrap";
import { readFileSync } from "fs";
import { join } from "path";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const sql = readFileSync(
      join(__dirname, "..", "supabase", "migrations", "20260704120000_sms_campaign_delivered_counter.sql"),
      "utf8",
    );
    await c.query(sql);
    console.log("✓ migration applied");
    const { rows: cols } = await c.query(
      `SELECT table_name, column_name, data_type, column_default
         FROM information_schema.columns
        WHERE (table_name = 'sms_campaigns' AND column_name = 'recipients_delivered')
           OR (table_name = 'sms_campaign_recipients' AND column_name = 'received_sms_logged_at')
        ORDER BY table_name, column_name`,
    );
    console.log("✓ columns:", cols);
    const { rows: idx } = await c.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'sms_campaign_recipients'
          AND indexname = 'idx_sms_campaign_recipients_rollup_pending'`,
    );
    console.log("✓ index:", idx);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
