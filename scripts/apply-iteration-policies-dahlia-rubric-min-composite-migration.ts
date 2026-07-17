// apply-iteration-policies-dahlia-rubric-min-composite-migration — add
// `iteration_policies.dahlia_rubric_min_composite` (integer NOT NULL default 7). This is
// the per-workspace threshold Max's Phase-2 5-axis Dahlia rubric composite must clear
// before a creative flips to ad_campaigns.status='ready' (Phase 3 of
// docs/brain/specs/dahlia-researches-from-winners-flow-ad-library.md).
//
// Additive + idempotent (add column IF NOT EXISTS). Safe to re-run. Not required to run
// manually — the Control Tower migration-drift reconciler
// (`applyMergedMigrations` in src/lib/control-tower/migration-drift.ts) auto-applies this
// on merge to main because `classifyMigrationSql` verdict is `additive`. This script
// exists so a) the `tagPendingActionType` classifier can re-tag any manual invocation as
// `apply_migration` and self-approve, and b) an operator can re-apply idempotently.
//
//   npx tsx scripts/apply-iteration-policies-dahlia-rubric-min-composite-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = [
  "20261103120000_iteration_policies_dahlia_rubric_min_composite.sql",
];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema='public'
          and table_name='iteration_policies'
          and column_name='dahlia_rubric_min_composite'`,
    );
    if (rows.length !== 1) {
      throw new Error(
        `expected 1 dahlia_rubric_min_composite column, got ${rows.length}: ${JSON.stringify(rows)}`,
      );
    }
    const r = rows[0];
    if (r.data_type !== "integer") throw new Error(`expected integer, got ${r.data_type}`);
    if (r.is_nullable !== "NO") throw new Error(`expected NOT NULL, got is_nullable=${r.is_nullable}`);
    console.log(
      `✓ iteration_policies.dahlia_rubric_min_composite: type=${r.data_type} nullable=${r.is_nullable} default=${r.column_default}`,
    );
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
