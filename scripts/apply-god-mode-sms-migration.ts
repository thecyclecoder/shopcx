// apply-god-mode-sms-migration — add workspaces.god_mode_sms_number (Phase 5
// of docs/brain/specs/god-mode.md). Idempotent (ADD COLUMN IF NOT EXISTS).
//   npx tsx scripts/apply-god-mode-sms-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260909120000_god_mode_sms_number.sql"];

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
        where table_schema='public' and table_name='workspaces' and column_name='god_mode_sms_number'`,
    );
    if (!rows.length) throw new Error("workspaces.god_mode_sms_number missing");
    console.log("✓ workspaces.god_mode_sms_number exists");
  } finally {
    await c.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
