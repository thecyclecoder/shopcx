// apply-god-mode-active-plan-migration — god_mode_sessions.active_plan_id +
// widen god_mode_approvals.risk CHECK to include 'plan'. Plan-scoped approvals
// hotfix (docs/brain/specs/god-mode.md follow-on). Idempotent.
//   npx tsx scripts/apply-god-mode-active-plan-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260910120000_god_mode_active_plan.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: col } = await c.query(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='god_mode_sessions' and column_name='active_plan_id'`,
    );
    if (!col.length) throw new Error("god_mode_sessions.active_plan_id missing");
    console.log("✓ god_mode_sessions.active_plan_id exists");

    const { rows: chk } = await c.query(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid='public.god_mode_approvals'::regclass and conname='god_mode_approvals_risk_check'`,
    );
    if (!chk.length || !/\bplan\b/.test(chk[0].def)) throw new Error("risk CHECK not widened to include 'plan'");
    console.log(`✓ risk CHECK now: ${chk[0].def}`);
  } finally {
    await c.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
