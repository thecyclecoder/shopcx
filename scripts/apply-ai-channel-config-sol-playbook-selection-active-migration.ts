// apply-ai-channel-config-sol-playbook-selection-active-migration — Phase 3 of
// docs/brain/specs/sol-session-chosen-playbook-selection-retire-brittle-triggers.md.
// Adds ai_channel_config.sol_playbook_selection_active boolean NOT NULL DEFAULT false so the
// unified-ticket-handler's Sol-chosen branch (§ 2a) can be per-channel gated. Idempotent.
//
// Run against the pooler:
//   npx tsx scripts/apply-ai-channel-config-sol-playbook-selection-active-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260708130000_ai_channel_config_sol_playbook_selection_active.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: cols } = await c.query(
      `select column_name, is_nullable, column_default from information_schema.columns
       where table_schema='public' and table_name='ai_channel_config' and column_name='sol_playbook_selection_active'`,
    );
    console.log(
      `✓ ai_channel_config.sol_playbook_selection_active present: ${cols.length === 1}, nullable: ${cols[0]?.is_nullable ?? "n/a"}, default: ${cols[0]?.column_default ?? "n/a"}`,
    );
  } finally {
    await c.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
