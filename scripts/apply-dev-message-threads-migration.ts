/**
 * Apply the dev_message_threads migration (the Developer > Message Center thread store: messages,
 * box_session_id, turn_status, last_error, pending_actions + RLS). Idempotent. Gated prod write.
 * Run: npx tsx scripts/apply-dev-message-threads-migration.ts
 * See docs/brain/specs/developer-message-center.md.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const migrationPath = resolve(__dirname, "../supabase/migrations/20260621120000_dev_message_threads.sql");
const sql = readFileSync(migrationPath, "utf8");

async function main() {
  const client = pgClient();
  await client.connect();
  try {
    await client.query(sql);
    console.log("✓ Applied 20260621120000_dev_message_threads.sql");
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
