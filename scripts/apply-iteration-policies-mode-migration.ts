// apply-iteration-policies-mode-migration — add `mode` (shadow|armed) column to
// public.iteration_policies (media-buyer-shadow-mode Phase 1). Idempotent (ADD COLUMN
// IF NOT EXISTS + guarded backfill).
// Run against the pooler:
//   npx tsx scripts/apply-iteration-policies-mode-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260708021500_iteration_policies_mode.sql";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8"));
    console.log(`✓ applied ${MIGRATION}`);
    const { rows: col } = await c.query(
      "select column_name, data_type, column_default, is_nullable from information_schema.columns where table_name='iteration_policies' and column_name='mode'",
    );
    console.log(`✓ mode column: ${JSON.stringify(col[0] ?? null)}`);
    const { rows: chk } = await c.query(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conrelid='public.iteration_policies'::regclass and contype='c' and pg_get_constraintdef(oid) ilike '%mode%'",
    );
    console.log(`✓ mode CHECK: ${chk.map((r) => r.def).join(" | ") || "(none)"}`);
    const { rows: dist } = await c.query(
      "select status, mode, count(*)::int as n from public.iteration_policies group by status, mode order by status, mode",
    );
    console.log(`✓ mode distribution by status: ${JSON.stringify(dist)}`);
    console.log("applied");
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
