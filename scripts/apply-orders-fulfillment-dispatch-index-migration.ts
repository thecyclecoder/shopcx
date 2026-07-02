// apply-orders-fulfillment-dispatch-index-migration — add the partial index that turns the
// Amplifier fulfillment-dispatch queue query (paid + unfulfilled + amplifier_order_id IS NULL)
// from a full Seq Scan of the ~133k-row orders table into a workspace_id + created_at Index Scan
// (measured 1351ms -> 0.77ms; index is ~16 kB). See
// supabase/migrations/20260806120000_orders_fulfillment_dispatch_index.sql.
//
// Runs CREATE INDEX CONCURRENTLY so it never locks the hot orders table. CONCURRENTLY can't run
// inside a transaction block, so the statement is issued on its own (NOT the multi-statement file,
// which Postgres would wrap implicitly). Idempotent via IF NOT EXISTS.
//   npx tsx scripts/apply-orders-fulfillment-dispatch-index-migration.ts
import { pgClient } from "./_bootstrap";

const STATEMENTS = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_pending_amplifier_dispatch
     ON public.orders (workspace_id, created_at DESC)
     WHERE amplifier_order_id IS NULL
       AND financial_status = 'paid'
       AND (fulfillment_status IS NULL OR fulfillment_status <> 'fulfilled')`,
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
       where tablename = 'orders'
         and indexname = 'idx_orders_pending_amplifier_dispatch'`,
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
