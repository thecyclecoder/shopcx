// apply-loyalty-program-stats-migration — create the loyalty_program_stats(p_workspace_id) RPC
// (docs/brain/specs/loyalty-list-stats-and-adjust-guard.md Phase 1). Program-wide SUM/AVG over
// ALL loyalty_members so the dashboard header cards stop lying on workspaces with >250 members.
// Idempotent (CREATE OR REPLACE FUNCTION).
//   npx tsx scripts/apply-loyalty-program-stats-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260913120000_loyalty_program_stats.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select proname from pg_proc where proname = 'loyalty_program_stats'",
    );
    console.log("✓ function present:", rows.map((r) => r.proname));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
