// apply-tickets-ai-disabled-migration — add tickets.ai_disabled + ai_disabled_by + ai_disabled_at
// (docs/brain/specs/human-directives-hard-gates-over-ticket-ai.md, Phase 1): the per-ticket
// "turn off AI" hard gate the unified ticket handler + the ticket-analyzer cron both
// short-circuit on. Non-propagating on merge (see src/lib/ticket-merge.ts). Idempotent
// (ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS).
//   npx tsx scripts/apply-tickets-ai-disabled-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260921120000_tickets_ai_disabled.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select column_name from information_schema.columns where table_name = 'tickets' and column_name in ('ai_disabled', 'ai_disabled_by', 'ai_disabled_at') order by column_name",
    );
    console.log("✓ columns present:", rows.map((r) => r.column_name));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
