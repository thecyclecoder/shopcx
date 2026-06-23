// apply-competitors-migration — create the Competitor Scout DB-driven competitor set
// (docs/brain/specs/competitor-scout.md, Phase 1):
//   competitors — per-workspace, supervisable competitor brands (proposed→approved→rejected),
//                 replacing the hardcoded COMPETITOR_SEEDS. Seeds the 11 legacy brands in as
//                 status='approved' for every ad-tool workspace.
// Idempotent (CREATE TABLE / INDEX / POLICY IF NOT EXISTS + ON CONFLICT DO NOTHING). Run via:
//   npx tsx scripts/apply-competitors-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260623120000_competitors.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select status, count(*)::int as n from public.competitors group by status order by status",
    );
    console.log("✓ competitors by status:", rows);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
