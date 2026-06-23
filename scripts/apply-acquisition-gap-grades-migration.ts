// apply-acquisition-gap-grades-migration — create acquisition_gap_grades + acquisition_grader_prompts
// (docs/brain/specs/acquisition-research-loop-grading.md, Phase 1; M5 of the Acquisition Research
// Engine): the Growth-director gap→outcome grade that trains the scouts, mirroring the storefront
// campaign-grading loop. Idempotent (CREATE … IF NOT EXISTS).
//   npx tsx scripts/apply-acquisition-gap-grades-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260623150000_acquisition_gap_grades.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select table_name from information_schema.tables where table_name in ('acquisition_gap_grades', 'acquisition_grader_prompts') order by table_name",
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
