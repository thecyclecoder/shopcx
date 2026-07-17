// apply-ad-creative-copy-qc-verdicts-dahlia-rubric-migration — add
// `declared_intent jsonb` + `dahlia_rubric jsonb` columns on
// public.ad_creative_copy_qc_verdicts (docs/brain/specs/dahlia-researches-from-winners-flow-ad-library.md
// Phase 2). Idempotent (ADD COLUMN IF NOT EXISTS). Safe to re-run.
//
// Not required to be run manually — the Control Tower migration-drift reconciler
// (`applyMergedMigrations` in src/lib/control-tower/migration-drift.ts) auto-applies this
// on merge to main because `classifyMigrationSql` verdict is `additive`. This script exists
// so a) the `tagPendingActionType` classifier can re-tag any manual invocation as
// `apply_migration` and self-approve, and b) an operator can re-apply idempotently against
// a fresh environment.
//
//   npx tsx scripts/apply-ad-creative-copy-qc-verdicts-dahlia-rubric-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = [
  "20261102120000_ad_creative_copy_qc_verdicts_dahlia_rubric.sql",
];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    // Verify both columns landed with the expected shape.
    const { rows } = await c.query(
      `select column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema='public'
          and table_name='ad_creative_copy_qc_verdicts'
          and column_name in ('declared_intent', 'dahlia_rubric')
        order by column_name`,
    );
    if (rows.length !== 2) {
      throw new Error(
        `expected 2 new columns (declared_intent, dahlia_rubric), got ${rows.length}: ${JSON.stringify(rows)}`,
      );
    }
    for (const r of rows) {
      if (r.data_type !== "jsonb") {
        throw new Error(`expected ${r.column_name} to be jsonb, got ${r.data_type}`);
      }
      if (r.is_nullable !== "YES") {
        throw new Error(`expected ${r.column_name} to be nullable, got is_nullable=${r.is_nullable}`);
      }
      console.log(`✓ ad_creative_copy_qc_verdicts.${r.column_name}: type=${r.data_type} nullable=${r.is_nullable}`);
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
