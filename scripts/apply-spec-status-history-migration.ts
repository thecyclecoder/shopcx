// apply-spec-status-history-migration — spec-status-db-driven Phase 1.
//
// Creates ONLY the `spec_status_history` audit table. The Phase 1 boolean flags (`critical`,
// `deferred`) live on the existing `spec_card_state.flags` jsonb column — no schema change there.
// Idempotent (CREATE TABLE / INDEX IF NOT EXISTS; DROP POLICY IF EXISTS + CREATE).
//
// Apply:
//   npx tsx scripts/apply-spec-status-history-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260624130000_spec_status_history.sql";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const sql = readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8");
    await c.query(sql);
    console.log(`✓ applied ${MIGRATION}`);

    const hist = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='spec_status_history'",
    );
    console.log(`✓ spec_status_history table present: ${hist.rows[0].n === 1}`);

    const cols = await c.query(
      `select column_name, data_type from information_schema.columns
        where table_schema='public' and table_name='spec_status_history'
        order by ordinal_position`,
    );
    console.log(`✓ columns: ${cols.rows.map((r) => `${r.column_name}:${r.data_type}`).join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
