// apply-drop-klaviyo-profile-events-profile-metric-dt-index — remove the unused composite
// index flagged by the DB Health Agent (signature
// dbhealth:unused-index:klaviyo_profile_events_profile_metric_dt) so INSERTs into
// klaviyo_profile_events stop paying its maintenance cost.
//
// Runs DROP INDEX CONCURRENTLY so it doesn't take an ACCESS EXCLUSIVE lock on the hot
// table while the Klaviyo events import is writing. CONCURRENTLY can't run inside a
// transaction block, so the statement is issued on its own (NOT the migration file,
// which Postgres would wrap implicitly). Idempotent via IF EXISTS.
//   npx tsx scripts/apply-drop-klaviyo-profile-events-profile-metric-dt-index.ts
import { pgClient } from "./_bootstrap";

const STATEMENTS = [
  `DROP INDEX CONCURRENTLY IF EXISTS public.klaviyo_profile_events_profile_metric_dt`,
];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const sql of STATEMENTS) {
      await c.query(sql);
      console.log(`✓ ${sql.trim().split("\n")[0]} …`);
    }
    const { rows } = await c.query(
      `select indexname from pg_indexes
       where schemaname = 'public'
         and tablename = 'klaviyo_profile_events'
       order by indexname`,
    );
    console.log("✓ remaining indexes on klaviyo_profile_events:", rows.map((r) => r.indexname));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
