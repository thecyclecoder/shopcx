// apply-ticket-required-outcomes-migration — create public.ticket_required_outcomes plus its two
// indexes (`(workspace_id, ticket_id, authored_at ASC)` for the per-ticket list read, and the
// partial `(workspace_id, ticket_id) WHERE status <> 'verified'` for the completion-gate probe)
// and enable RLS.
//
// Phase 1 of docs/brain/specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified.md.
// Idempotent (CREATE TABLE / CREATE INDEX IF NOT EXISTS). Run against the pooler:
//   npx tsx scripts/apply-ticket-required-outcomes-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261001120000_ticket_required_outcomes.sql"];

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
        where table_schema='public' and table_name='ticket_required_outcomes'
        order by ordinal_position`,
    );
    if (cols.length === 0) throw new Error("ticket_required_outcomes table missing after migration");
    console.log(`✓ ticket_required_outcomes has ${cols.length} column(s):`);
    for (const col of cols) console.log(`    - ${col.column_name} ${col.data_type} nullable=${col.is_nullable}`);

    const { rows: idx } = await c.query(
      `select indexname from pg_indexes
        where schemaname='public' and tablename='ticket_required_outcomes'
        order by indexname`,
    );
    const idxNames = idx.map((r) => r.indexname);
    const need = [
      "ticket_required_outcomes_workspace_ticket_authored_at_idx",
      "ticket_required_outcomes_open_by_ticket_idx",
    ];
    for (const n of need) {
      if (!idxNames.includes(n)) throw new Error(`index ${n} missing after migration`);
    }
    console.log(`✓ indexes present: ${need.join(", ")}`);

    const { rows: rls } = await c.query(
      `select relrowsecurity from pg_class where relname='ticket_required_outcomes' and relnamespace='public'::regnamespace`,
    );
    if (!rls[0]?.relrowsecurity) throw new Error("RLS not enabled on ticket_required_outcomes");
    console.log(`✓ RLS enabled on ticket_required_outcomes`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
