// apply-god-mode-ceo-grade-migration — god_mode_approvals.category + widen risk
// CHECK to include 'decision' + create god_mode_standing_grants. CEO-grade approval
// model (docs/brain/lifecycles/god-mode.md follow-on). Idempotent.
//   npx tsx scripts/apply-god-mode-ceo-grade-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260911120000_god_mode_ceo_grade.sql"];

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
        where table_schema='public' and table_name='god_mode_approvals' and column_name='category'`,
    );
    if (!col.length) throw new Error("god_mode_approvals.category missing");
    console.log("✓ god_mode_approvals.category exists");

    const { rows: chk } = await c.query(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid='public.god_mode_approvals'::regclass and conname='god_mode_approvals_risk_check'`,
    );
    if (!chk.length || !/\bdecision\b/.test(chk[0].def)) throw new Error("risk CHECK not widened to include 'decision'");
    console.log(`✓ risk CHECK now: ${chk[0].def}`);

    const { rows: tbl } = await c.query(
      `select table_name from information_schema.tables
        where table_schema='public' and table_name='god_mode_standing_grants'`,
    );
    if (!tbl.length) throw new Error("god_mode_standing_grants table missing");
    console.log("✓ god_mode_standing_grants exists");
  } finally {
    await c.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
