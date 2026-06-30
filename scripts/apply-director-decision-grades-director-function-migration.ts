// apply-director-decision-grades-director-function-migration — add director_function to
// director_decision_grades (docs/brain/specs/growth-adopt-meta-iteration-engine.md, Phase 2). Stamps
// each grade row with the director it belongs to ('platform' | 'growth') so the per-director report
// + per-director leash-loosen/tighten recommendations stop blurring the two pools. Idempotent.
//   npx tsx scripts/apply-director-decision-grades-director-function-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260804120000_director_decision_grades_director_function.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select column_name, data_type, column_default from information_schema.columns where table_name='director_decision_grades' and column_name='director_function'",
    );
    console.log("✓ director_function column:", rows);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
