// apply-director-activity-migration — create public.director_activity (regression-agent Phase 1 / the
// devops-director audit substrate: the timestamped action log every director + worker writes a row to
// on each action). Idempotent (CREATE TABLE / INDEX IF NOT EXISTS · DROP/CREATE POLICY). Run against
// the pooler:
//   npx tsx scripts/apply-director-activity-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260702120000_director_activity.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='director_activity'",
    );
    console.log(`✓ director_activity table present: ${rows[0].n === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
