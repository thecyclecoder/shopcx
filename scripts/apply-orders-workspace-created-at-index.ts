// apply-orders-workspace-created-at-index — build the composite
// (workspace_id, created_at DESC) index the DB Health Agent flagged
// (signature dbhealth:slowq:4495583167845289108:orders) so workspace order
// timelines stop sorting on every read.
//
// Uses CREATE INDEX CONCURRENTLY so the build doesn't block writes on the hot
// orders table. CONCURRENTLY can't run inside a transaction, so each statement
// is issued on its own (no implicit BEGIN). Idempotent via IF NOT EXISTS.
//   npx tsx scripts/apply-orders-workspace-created-at-index.ts
import { pgClient } from "./_bootstrap";

const statements = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_workspace_id_created_at_idx
     ON public.orders (workspace_id, created_at DESC);`,
];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const sql of statements) {
      const label = sql.split("\n")[0].trim().slice(0, 80);
      console.log(`→ ${label}`);
      const started = Date.now();
      await c.query(sql);
      console.log(`  done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
    const { rows } = await c.query(`
      select indexname, indexdef
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'orders'
        and indexname = 'orders_workspace_id_created_at_idx';
    `);
    console.log("\nVerified:");
    for (const r of rows) console.log(`  ${r.indexname} — ${r.indexdef}`);
    if (rows.length === 0) {
      throw new Error("orders_workspace_id_created_at_idx not found after apply");
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
