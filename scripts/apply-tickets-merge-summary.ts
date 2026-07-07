// apply-tickets-merge-summary — add merge_summary + merge_summary_at columns to
// public.tickets so a merge event can lock in the pre-merge state and downstream
// Opus turns read the summary instead of re-costing the full history each turn.
// (docs/brain/specs/ticket-merge-summary-and-context-cap.md, Phase 1). Idempotent
// (ADD COLUMN IF NOT EXISTS).
//   npx tsx scripts/apply-tickets-merge-summary.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260921120000_tickets_merge_summary.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      `select column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'tickets'
          and column_name in ('merge_summary', 'merge_summary_at')
        order by column_name`,
    );
    console.log("✓ columns present:", rows);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
