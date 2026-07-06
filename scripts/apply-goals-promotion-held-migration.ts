// apply-goals-promotion-held-migration — add public.goals.main_merge_sha + promotion_held_reason
// (goal-promotion-fold-collision-and-held-surfacing Phase 2). Idempotent (add column IF NOT EXISTS).
// Backs the roadmap "HELD — needs owner" badge + the silent-stall backstop that never renders a
// not-on-main goal as fully shipped. Two nullable text columns, no data write.
//   npx tsx scripts/apply-goals-promotion-held-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260915120000_goals_promotion_held.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'goals'
          and column_name in ('main_merge_sha','promotion_held_reason')
        order by column_name`,
    );
    console.log("✓ columns present:", rows.map((r) => r.column_name));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
