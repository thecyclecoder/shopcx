// apply-cs-director-grader-cancel-after-renewal — seed the CS-Director cancel-after-
// renewal calibration clause into director_grader_prompts (spec cancel-after-renewal,
// Phase 2). Applies the seed migration then prints every workspace_id that now carries
// the row for verification.
//
// The migration is idempotent (NOT EXISTS on (workspace_id, title)) and never destructive
// — an existing row keeps whatever status the CEO later moved it to. One row per workspace
// is seeded at status='approved' with sort_order=11 so the deployed grader prompt in
// src/lib/agents/director-grader.ts (buildDirectorGraderSystemPrompt) picks it up
// immediately — right after the anti-Goodhart clause — without a per-workspace CEO
// approval step.
//
//   npx tsx scripts/apply-cs-director-grader-cancel-after-renewal.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20261125123000_cs_director_grader_cancel_after_renewal.sql";
const RULE_TITLE = "CS Director cancel-after-renewal — never escalate_founder";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8"));
    console.log(`✓ applied ${MIGRATION}`);

    const { rows } = await c.query(
      "select workspace_id, status, sort_order from public.director_grader_prompts where title = $1 order by workspace_id",
      [RULE_TITLE],
    );
    console.log(`✓ cancel-after-renewal clause rows: ${rows.length}`);
    for (const r of rows) {
      console.log(`  ws=${r.workspace_id} status=${r.status} sort=${r.sort_order}`);
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
