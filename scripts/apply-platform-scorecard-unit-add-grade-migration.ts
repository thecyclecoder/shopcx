// apply-platform-scorecard-unit-add-grade-migration — extend the unit CHECK on
// platform_scorecard_snapshots to allow 'grade' (docs/brain/specs/devops-kpi-review-sdk-and-data-fix.md
// Phase 2). Required before the engine can UPSERT rows for worker_grade_rollup +
// director_call_grade under their new unit='grade' stamp. Idempotent (drop-constraint-if-exists +
// add the expanded one).
//   npx tsx scripts/apply-platform-scorecard-unit-add-grade-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260726120000_platform_scorecard_unit_add_grade.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(`
      select pg_get_constraintdef(c.oid) as def
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      where t.relname = 'platform_scorecard_snapshots'
        and c.conname = 'platform_scorecard_snapshots_unit_check'
    `);
    if (rows.length) console.log(`✓ unit check: ${rows[0].def}`);
    else console.error("✗ platform_scorecard_snapshots_unit_check missing after apply");
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
