// apply-director-decision-grades-migration — create director_decision_grades + director_grader_prompts
// (docs/brain/specs/director-loop-grading.md, Phase 2; M5 of the devops-director goal): the CEO's
// 1–10 grade of the Platform/DevOps Director's calls (auto-approval + goal-escort) + its calibration
// store, mirroring the storefront campaign-grading loop one level up the org chart. Idempotent
// (CREATE … IF NOT EXISTS).
//   npx tsx scripts/apply-director-decision-grades-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260704120000_director_decision_grades.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select table_name from information_schema.tables where table_name in ('director_decision_grades', 'director_grader_prompts') order by table_name",
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
