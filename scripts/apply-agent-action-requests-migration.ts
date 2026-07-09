// apply-agent-action-requests-migration — create public.agent_action_requests plus its two indexes
// (the partial `(status, created_at) WHERE status IN ('pending','pending_condition')` claim scan and
// the `(ticket_id, created_at DESC)` per-ticket lookup). This is the queue that lets Sol's read-only
// ticket-handle box session request bounded, verified mutations (enqueue → worker-execute → poll).
//
// Sol cheap-execution (enqueue→poll→adapt). Idempotent (CREATE TABLE / CREATE INDEX IF NOT EXISTS).
// Run against the pooler:
//   npx tsx scripts/apply-agent-action-requests-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260709130000_agent_action_requests.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }

    const { rows: cols } = await c.query(
      `select column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema='public' and table_name='agent_action_requests'
        order by ordinal_position`,
    );
    if (cols.length === 0) throw new Error("agent_action_requests table missing after migration");
    console.log(`✓ agent_action_requests has ${cols.length} column(s):`);
    for (const col of cols) console.log(`    - ${col.column_name} ${col.data_type} nullable=${col.is_nullable}`);

    const { rows: idx } = await c.query(
      `select indexname from pg_indexes
        where schemaname='public' and tablename='agent_action_requests'
        order by indexname`,
    );
    const idxNames = idx.map((r) => r.indexname);
    const need = ["idx_agent_action_requests_claim", "idx_agent_action_requests_ticket"];
    for (const n of need) {
      if (!idxNames.includes(n)) throw new Error(`expected index ${n} missing`);
      console.log(`✓ index ${n}`);
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
