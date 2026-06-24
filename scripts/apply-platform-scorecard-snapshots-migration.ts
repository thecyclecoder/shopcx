// apply-platform-scorecard-snapshots-migration — create platform_scorecard_snapshots
// (docs/brain/specs/platform-scorecard-engine.md, Phase 1; milestone (a) Daily pulse of the
// platform-department-scorecard goal): the department-level KPI trend store the Platform Scorecard
// engine (src/lib/agents/platform-scorecard.ts) upserts every value into so KPIs trend over time.
// Idempotent (CREATE … IF NOT EXISTS).
//   npx tsx scripts/apply-platform-scorecard-snapshots-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260706120000_platform_scorecard_snapshots.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select table_name from information_schema.tables where table_name = 'platform_scorecard_snapshots'",
    );
    if (rows.length) console.log("✓ table present: platform_scorecard_snapshots");
    else console.error("✗ table missing after apply: platform_scorecard_snapshots");
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
