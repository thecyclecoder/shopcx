// apply-tickets-escalated-at-partial-index-migration — back /api/escalated with a partial
// btree so the Escalated dashboard stops timing out at Vercel's 300s function limit
// (docs/brain/specs/tickets-escalated-at-partial-index.md).
//
// Runs CREATE INDEX CONCURRENTLY so it doesn't take a long lock on the hot tickets table.
// CONCURRENTLY can't run inside a transaction block, so the statement is issued on its own
// (NOT the migration file, which Postgres would wrap implicitly). Idempotent via IF NOT EXISTS.
//   npx tsx scripts/apply-tickets-escalated-at-partial-index-migration.ts
import { pgClient } from "./_bootstrap";

const STATEMENTS = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tickets_escalated
     ON public.tickets (workspace_id, escalated_at DESC)
     WHERE escalated_at IS NOT NULL`,
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
       where tablename = 'tickets'
         and indexname = 'idx_tickets_escalated'`,
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
