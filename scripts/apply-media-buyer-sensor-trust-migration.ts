// apply-media-buyer-sensor-trust-migration — create public.media_buyer_sensor_trust
// + additive threshold columns on public.media_buyer_test_cohorts
// (media-buyer-sensor-trust-probe Phase 1). Idempotent (CREATE TABLE / TRIGGER /
// POLICY IF NOT EXISTS, ADD COLUMN IF NOT EXISTS).
// Run against the pooler:
//   npx tsx scripts/apply-media-buyer-sensor-trust-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = [
  "20260928120000_media_buyer_sensor_trust.sql",
  "20260928130000_media_buyer_test_cohorts_sensor_trust_thresholds.sql",
];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: t } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='media_buyer_sensor_trust'",
    );
    console.log(`✓ media_buyer_sensor_trust table present: ${t[0].n === 1}`);
    const { rows: cols } = await c.query(
      "select column_name from information_schema.columns where table_name='media_buyer_sensor_trust' order by ordinal_position",
    );
    console.log(`✓ media_buyer_sensor_trust columns: ${cols.map((r) => r.column_name).join(", ")}`);
    const { rows: idx } = await c.query(
      "select indexname from pg_indexes where tablename='media_buyer_sensor_trust'",
    );
    console.log(`✓ media_buyer_sensor_trust indexes: ${idx.map((r) => r.indexname).join(", ")}`);
    const { rows: thresholds } = await c.query(
      "select column_name from information_schema.columns where table_name='media_buyer_test_cohorts' and column_name in ('green_min_coverage','yellow_min_coverage','max_unresolved_share') order by column_name",
    );
    console.log(
      `✓ media_buyer_test_cohorts threshold columns: ${thresholds.map((r) => r.column_name).join(", ")}`,
    );
    console.log("applied");
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
