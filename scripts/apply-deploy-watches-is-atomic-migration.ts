// apply-deploy-watches-is-atomic-migration — add public.deploy_watches.is_atomic
// (spec-goal-branch-pm-flow Reva alignment: mark a watch that guards an M5 atomic goal→main promotion so
// the deploy-guardian ESCALATES a regression on a goal-sized deploy instead of auto-reverting a whole goal).
// Idempotent (ADD COLUMN IF NOT EXISTS). Run against the pooler:
//   npx tsx scripts/apply-deploy-watches-is-atomic-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260730120000_deploy_watches_is_atomic.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.columns where table_name='deploy_watches' and column_name='is_atomic'",
    );
    console.log(`✓ deploy_watches.is_atomic column present: ${rows[0].n === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
