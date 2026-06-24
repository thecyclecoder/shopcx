// apply-account-matching-indexes-migration — add the per-branch indexes that let
// findUnlinkedMatches do a Bitmap Index Scan per branch instead of a Seq Scan of the 620k-row
// customers table (docs/brain/specs/account-matching-indexed-split.md, Control Tower signature
// supabase-logs:b5db594131381078).
//
// Runs CREATE INDEX CONCURRENTLY so it doesn't take a long lock on the hot customers table.
// CONCURRENTLY can't run inside a transaction block, so each statement is issued on its own
// (NOT the multi-statement migration file, which Postgres would wrap implicitly). Idempotent
// via IF NOT EXISTS.
//   npx tsx scripts/apply-account-matching-indexes-migration.ts
import { pgClient } from "./_bootstrap";

const STATEMENTS = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_customers_name_match
     ON public.customers (workspace_id, first_name, last_name)
     WHERE first_name IS NOT NULL AND last_name IS NOT NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_customers_phone
     ON public.customers (workspace_id, phone)
     WHERE phone IS NOT NULL`,
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
         and indexname in ('idx_customers_name_match', 'idx_customers_phone')
       order by indexname`,
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
