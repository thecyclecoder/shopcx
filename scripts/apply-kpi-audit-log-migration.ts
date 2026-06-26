// apply-kpi-audit-log-migration — create the kpi_audit_log table (per-metric
// drift trend rows written by the `audit-platform-scorecard` step on
// platform-director-cron; docs/brain/specs/devops-kpi-review-sdk-and-data-fix.md
// Phase 5). Idempotent (create-if-not-exists + drop-policy-if-exists). Run from
// the box once before merging the Phase 5 PR.
//   npx tsx scripts/apply-kpi-audit-log-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260726130000_kpi_audit_log.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(`
      select column_name, data_type
      from information_schema.columns
      where table_schema = 'public' and table_name = 'kpi_audit_log'
      order by ordinal_position
    `);
    if (rows.length) {
      console.log(`✓ kpi_audit_log columns (${rows.length}):`);
      for (const r of rows) console.log(`    ${r.column_name} ${r.data_type}`);
    } else {
      console.error("✗ kpi_audit_log missing after apply");
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
