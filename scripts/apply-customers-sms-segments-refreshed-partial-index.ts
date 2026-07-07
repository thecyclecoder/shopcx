// apply-customers-sms-segments-refreshed-partial-index — back the Control
// Tower's SMS-subscribed stale-tail head-count with a partial btree on
// customers(segments_refreshed_at) WHERE sms_marketing_status='subscribed', so
// the monitor's `is.null OR lt.<cutoff>` OR predicate is answered by BitmapOr
// index scans instead of a full heap sweep over the ~138K subscribed rows.
// Fixes Supabase-logs 500 signature b9905c8e7f3f9e56 hit ~once a day by the
// HEAD /rest/v1/customers count query added in fix-segment-refresh-coverage P2.
//
// Runs CREATE INDEX CONCURRENTLY so it doesn't take a long lock on the hot
// customers table (620k+ rows). CONCURRENTLY can't run inside a transaction
// block, so the statement is issued on its own (NOT the migration file, which
// Postgres would wrap implicitly). Idempotent via IF NOT EXISTS.
//   npx tsx scripts/apply-customers-sms-segments-refreshed-partial-index.ts
import { pgClient } from "./_bootstrap";

const STATEMENTS = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_customers_sms_subscribed_segments_refreshed_at
     ON public.customers (segments_refreshed_at)
     WHERE sms_marketing_status = 'subscribed'`,
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
       where tablename = 'customers'
         and indexname = 'idx_customers_sms_subscribed_segments_refreshed_at'`,
    );
    console.log("✓ present:", rows.map((r) => r.indexname));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
