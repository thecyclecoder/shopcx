// apply-ticket-directions-migration — create public.ticket_directions +
// the ticket_direction_path enum + the (workspace_id, ticket_id, authored_at DESC) read index
// and the partial UNIQUE (ticket_id) WHERE superseded_at IS NULL live-row-invariant index.
//
// Phase 1 of docs/brain/specs/sol-ticket-direction-artifact-and-first-touch-box-session.md.
// Idempotent (CREATE TABLE / CREATE INDEX IF NOT EXISTS + DO-guarded CREATE TYPE). Run against
// the pooler:
//   npx tsx scripts/apply-ticket-directions-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260925120000_ticket_directions.sql"];

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
        where table_schema='public' and table_name='ticket_directions'
        order by ordinal_position`,
    );
    if (cols.length === 0) throw new Error("ticket_directions table missing after migration");
    console.log(`✓ ticket_directions has ${cols.length} column(s):`);
    for (const col of cols) console.log(`    - ${col.column_name} ${col.data_type} nullable=${col.is_nullable}`);

    const { rows: idx } = await c.query(
      `select indexname from pg_indexes
        where schemaname='public' and tablename='ticket_directions'
        order by indexname`,
    );
    const idxNames = idx.map((r) => r.indexname);
    const need = [
      "ticket_directions_workspace_ticket_authored_at_idx",
      "ticket_directions_ticket_live_uidx",
    ];
    for (const n of need) {
      if (!idxNames.includes(n)) throw new Error(`index ${n} missing after migration`);
    }
    console.log(`✓ indexes present: ${need.join(", ")}`);

    const { rows: enumVals } = await c.query(
      `select unnest(enum_range(NULL::public.ticket_direction_path))::text as v`,
    );
    const vals = enumVals.map((r) => r.v).sort();
    const want = ["needs_info", "playbook", "stateless"];
    if (JSON.stringify(vals) !== JSON.stringify(want)) {
      throw new Error(`ticket_direction_path enum values mismatch: got ${JSON.stringify(vals)} want ${JSON.stringify(want)}`);
    }
    console.log(`✓ ticket_direction_path enum values: ${vals.join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
