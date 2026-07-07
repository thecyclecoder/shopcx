// apply-media-buyer-action-grades-migration — create public.media_buyer_action_grades
// (media-buyer-test-winner-loop Phase 3). The grading pass extends the box grading
// cascade with a Media Buyer grade: one row per concluded promote/kill/replenish
// action, scoring decision_quality + outcome_quality separately against realized
// ROAS resolved 3d+ later. Idempotent (create table if not exists, policy guards).
// Run against the pooler:
//   npx tsx scripts/apply-media-buyer-action-grades-migration.ts
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
      "select count(*)::int as n from information_schema.tables where table_name='media_buyer_action_grades'",
    );
    console.log(`✓ media_buyer_action_grades table present: ${t[0].n === 1}`);
    const { rows: cols } = await c.query(
      "select column_name from information_schema.columns where table_name='media_buyer_action_grades' order by ordinal_position",
    );
    console.log(`✓ media_buyer_action_grades columns: ${cols.map((r) => r.column_name).join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
