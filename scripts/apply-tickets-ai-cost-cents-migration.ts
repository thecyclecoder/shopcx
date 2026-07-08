// apply-tickets-ai-cost-cents-migration — add tickets.ai_cost_cents (bigint NOT
// NULL DEFAULT 0) + the atomic add_ticket_ai_cost(uuid, bigint) SECURITY
// DEFINER RPC. Phase 1 of docs/brain/specs/sol-cost-csat-measurement-vs-pre-sol-baseline.md.
// Idempotent (ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE FUNCTION). Run against
// the pooler:
//   npx tsx scripts/apply-tickets-ai-cost-cents-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260929120000_tickets_ai_cost_cents.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }

    const { rows: cols } = await c.query(
      `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema='public' and table_name='tickets' and column_name='ai_cost_cents'`,
    );
    if (cols.length === 0) throw new Error("tickets.ai_cost_cents missing after migration");
    const col = cols[0];
    if (col.is_nullable !== "NO") throw new Error(`tickets.ai_cost_cents must be NOT NULL, got is_nullable=${col.is_nullable}`);
    if (col.data_type !== "bigint") throw new Error(`tickets.ai_cost_cents must be bigint, got ${col.data_type}`);
    console.log(`✓ tickets.ai_cost_cents present: ${col.data_type} nullable=${col.is_nullable} default=${col.column_default}`);

    const { rows: fn } = await c.query(
      `select p.proname, pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='add_ticket_ai_cost'`,
    );
    if (fn.length === 0) throw new Error("add_ticket_ai_cost function missing after migration");
    console.log(`✓ add_ticket_ai_cost(${fn[0].args}) present`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
