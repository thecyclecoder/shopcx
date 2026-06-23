// apply-ad-gap-recommendations-migration — create the ad_gap_recommendations table
// (docs/brain/specs/acquisition-research-hub.md, Phase 1): the persisted, trackable queue for the
// Ad Creative Scout's gaps (the ad-side mirror of lander_recommendations). The Acquisition Research
// Hub materializes ad gaps here and routes approved ones to Build. Idempotent (CREATE … IF NOT EXISTS).
//   npx tsx scripts/apply-ad-gap-recommendations-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260623140000_ad_gap_recommendations.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select table_name from information_schema.tables where table_name = 'ad_gap_recommendations'",
    );
    console.log("✓ table present:", rows.map((r) => r.table_name));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
