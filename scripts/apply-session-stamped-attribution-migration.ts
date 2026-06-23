// apply-session-stamped-attribution-migration — experiment-session-stamped-attribution
// Phases 1+2: add storefront_sessions.experiment_assignments (jsonb) + GIN index, and
// orders.session_id (FK → storefront_sessions) + orders.anonymous_id + index. Idempotent
// (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS). Run against the pooler:
//   npx tsx scripts/apply-session-stamped-attribution-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = [
  "20260705120000_session_experiment_assignments.sql",
  "20260705120100_orders_session_link.sql",
];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: sess } = await c.query(
      `select 1 from information_schema.columns
        where table_name='storefront_sessions' and column_name='experiment_assignments'`,
    );
    const { rows: ord } = await c.query(
      `select column_name from information_schema.columns
        where table_name='orders' and column_name in ('session_id','anonymous_id')
        order by column_name`,
    );
    console.log(`✓ storefront_sessions.experiment_assignments present: ${sess.length === 1}`);
    console.log(`✓ orders columns present: ${ord.map((r) => r.column_name).join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
