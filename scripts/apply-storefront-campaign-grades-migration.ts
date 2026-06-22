// apply-storefront-campaign-grades-migration — create the Head-of-Growth campaign-grading
// loop tables (storefront-campaign-grading-loop spec, M5):
//   storefront_campaign_grades — one grade row per campaign (M4 experiment): initial + revised
//                                grade (both persist), hypothesis_quality / result_quality
//                                sub-scores, graded_by ∈ agent|human + override provenance
//   storefront_grader_prompts  — the calibration store (status ∈ proposed|approved|…)
// Idempotent (CREATE TABLE / INDEX / POLICY IF NOT EXISTS). Run against the pooler:
//   npx tsx scripts/apply-storefront-campaign-grades-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260628120000_storefront_campaign_grades.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    for (const table of ["storefront_campaign_grades", "storefront_grader_prompts"]) {
      const { rows } = await c.query(
        "select count(*)::int as n from information_schema.columns where table_schema='public' and table_name=$1",
        [table],
      );
      console.log(`✓ public.${table} has ${rows[0].n} columns`);
    }
    // Confirm the grade-range CHECKs + the calibration-store status CHECK landed.
    const { rows: checks } = await c.query(
      `select con.conname
         from pg_constraint con
         join pg_class rel on rel.oid = con.conrelid
        where rel.relname in ('storefront_campaign_grades', 'storefront_grader_prompts')
          and con.contype = 'c'
        order by con.conname`,
    );
    console.log(`✓ ${checks.length} CHECK constraints: ${checks.map((r) => r.conname).join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
