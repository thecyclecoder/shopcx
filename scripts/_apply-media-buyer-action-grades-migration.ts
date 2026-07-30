// _apply-media-buyer-action-grades-migration — create public.media_buyer_action_grades
// (media-buyer-test-winner-loop Phase 3, migration 20260707140000). Merged via #1311 but
// left unapplied (migration-drift backlog) — the missing table is the root cause of
// grade-rollup-on-growth-director-brief's 5 pre-merge spec-test regressions
// (to_regclass('public.media_buyer_action_grades') → null on the shared preview DB).
// Idempotent (create table if not exists + policy guards). CEO-approved direct apply.
//   npx tsx scripts/_apply-media-buyer-action-grades-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260707140000_media_buyer_action_grades.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: t } = await c.query(
      "select to_regclass('public.media_buyer_action_grades') is not null as present",
    );
    console.log(`✓ media_buyer_action_grades present: ${t[0].present}`);
    const { rows: cols } = await c.query(
      "select column_name from information_schema.columns where table_name='media_buyer_action_grades' order by ordinal_position",
    );
    console.log(`✓ columns: ${cols.map((r) => r.column_name).join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
