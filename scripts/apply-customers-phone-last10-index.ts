// apply-customers-phone-last10-index — expression index that matches the
// find_customers_by_phone / find_subscribed_customers_by_phone RPC predicate so STOP/START
// inbounds from the marketing shortcode (85041) plan as a Bitmap Index Scan on the 620k-row
// customers table instead of the Seq Scan that hit the statement timeout (Control Tower
// signature vercel:c1b10ab6583b7104). Migration:
//   supabase/migrations/20260818120000_customers_phone_last10_index.sql
//
// Runs CREATE INDEX CONCURRENTLY so it doesn't take a long lock on the hot customers table.
// CONCURRENTLY can't run inside a transaction block, so the statement is issued on its own
// (NOT the migration file, which Postgres would wrap implicitly). Idempotent via IF NOT EXISTS.
//   npx tsx scripts/apply-customers-phone-last10-index.ts
import { pgClient } from "./_bootstrap";

const STATEMENTS = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_customers_phone_last10
     ON public.customers (workspace_id, right(regexp_replace(phone, '\\D', '', 'g'), 10))
     WHERE phone IS NOT NULL
       AND length(regexp_replace(phone, '\\D', '', 'g')) >= 10`,
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
         and indexname = 'idx_customers_phone_last10'`,
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
