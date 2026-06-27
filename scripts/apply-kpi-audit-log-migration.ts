// apply-kpi-audit-log-migration — create the kpi_audit_log trend store + add owner/signature
// columns to loop_alerts (docs/brain/specs/devops-kpi-review-sdk-and-data-fix.md Phase 5).
// Required before the platform-director-cron `audit-platform-scorecard` step can write per-metric
// audit rows or open the `kpi_drift:<metric>:<cadence>` loop_alerts incidents. Idempotent
// (`create table if not exists` + `add column if not exists`).
//   npx tsx scripts/apply-kpi-audit-log-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = [
  "20260727120000_kpi_audit_log_and_loop_alerts_owner_signature.sql",
];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: tbl } = await c.query(`
      select column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public' and table_name = 'kpi_audit_log'
      order by ordinal_position
    `);
    console.log(`✓ kpi_audit_log (${tbl.length} columns)`);
    for (const r of tbl) console.log(`    - ${r.column_name} ${r.data_type}${r.is_nullable === "YES" ? "?" : ""}`);
    const { rows: la } = await c.query(`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'loop_alerts'
        and column_name in ('owner', 'signature')
      order by column_name
    `);
    if (la.length === 2) console.log(`✓ loop_alerts.owner + loop_alerts.signature present`);
    else console.error(`✗ expected owner+signature on loop_alerts, got: ${la.map((r) => r.column_name).join(", ") || "none"}`);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
