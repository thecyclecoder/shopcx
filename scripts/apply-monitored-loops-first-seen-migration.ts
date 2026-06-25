// apply-monitored-loops-first-seen-migration — create monitored_loops_first_seen
// (docs/brain/tables/monitored_loops_first_seen.md;
// control-tower-registered-not-firing-observed-anchor-grace P1): the empirical first-observed-at
// anchor for the Control Tower registered_not_firing grace. Without this table the new code path
// in src/lib/control-tower/monitor.ts ::buildControlTowerSnapshot best-effort-fails the read +
// upsert (logs a warn, falls back to the existing registeredAt-only grace), so the fix is inert
// in prod until the migration applies. Idempotent (CREATE … IF NOT EXISTS).
//   npx tsx scripts/apply-monitored-loops-first-seen-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260725150000_monitored_loops_first_seen.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select table_name from information_schema.tables where table_name = 'monitored_loops_first_seen'",
    );
    if (rows.length) console.log("✓ table present: monitored_loops_first_seen");
    else console.error("✗ table missing after apply: monitored_loops_first_seen");
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
