// apply-tickets-analyzer-locked-migration — add tickets.analyzer_locked + locked_by + locked_at
// (docs/brain/specs/human-directives-hard-gates-over-ticket-ai.md, Phase 2): the human veto over
// the ticket-analysis-cron re-select loop. When set, the cron won't reselect the row and
// applySeverityActions returns before any reopen/escalate (checked BEFORE forceEscalate).
// Non-propagating on merge (see src/lib/ticket-merge.ts). Idempotent (ADD COLUMN IF NOT
// EXISTS + CREATE INDEX IF NOT EXISTS).
//   npx tsx scripts/apply-tickets-analyzer-locked-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260922120000_tickets_analyzer_locked.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select column_name from information_schema.columns where table_name = 'tickets' and column_name in ('analyzer_locked', 'locked_by', 'locked_at') order by column_name",
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
