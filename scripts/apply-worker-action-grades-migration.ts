// apply-worker-action-grades-migration — create worker_action_grades + worker_grader_prompts
// (docs/brain/specs/worker-grading-and-director-management.md, P1): the DevOps Director's 1–10 grade of
// each worker's concluded actions (one row per concluded agent_jobs row) + its CEO-calibratable rubric
// store, mirroring director_decision_grades / director_grader_prompts one level DOWN the org chart.
// Idempotent (CREATE … IF NOT EXISTS).
//   npx tsx scripts/apply-worker-action-grades-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260705130000_worker_action_grades.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select table_name from information_schema.tables where table_name in ('worker_action_grades', 'worker_grader_prompts') order by table_name",
    );
    console.log("✓ tables present:", rows.map((r) => r.table_name));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
