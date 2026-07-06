// apply-ticket-resolution-events-migration — create public.ticket_resolution_events
// (Phase 1 of docs/brain/specs/ticket-resolution-events-writeahead-ledger-and-decision-schema-extension.md).
// Idempotent (CREATE TABLE IF NOT EXISTS + IF NOT EXISTS indexes). Run against the pooler:
//   npx tsx scripts/apply-ticket-resolution-events-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260917120000_ticket_resolution_events.sql"];

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
        where table_schema='public' and table_name='ticket_resolution_events'
        order by ordinal_position`,
    );
    if (cols.length === 0) throw new Error("ticket_resolution_events table missing after migration");
    console.log(`✓ ticket_resolution_events has ${cols.length} column(s):`);
    for (const col of cols) console.log(`    - ${col.column_name} ${col.data_type} nullable=${col.is_nullable}`);

    const { rows: idx } = await c.query(
      `select indexname from pg_indexes
        where schemaname='public' and tablename='ticket_resolution_events'
        order by indexname`,
    );
    const idxNames = idx.map((r) => r.indexname);
    const need = [
      "ticket_resolution_events_workspace_ticket_turn_idx",
      "ticket_resolution_events_workspace_staged_at_idx",
    ];
    for (const n of need) {
      if (!idxNames.includes(n)) throw new Error(`index ${n} missing after migration`);
    }
    console.log(`✓ indexes present: ${need.join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
