// apply-tickets-sol-handled-at-migration — add tickets.sol_handled_at (nullable
// timestamptz), the deterministic "Sol handled this ticket" signal Cora's feeder
// consumes in Phase 2 of docs/brain/specs/cora-grades-on-deterministic-sol-handled-signal-not-brittle-direction-existence.md.
// Idempotent (ADD COLUMN IF NOT EXISTS). Run against the pooler:
//   npx tsx scripts/apply-tickets-sol-handled-at-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261005130000_tickets_sol_handled_at.sql"];

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
        where table_schema='public' and table_name='tickets' and column_name='sol_handled_at'`,
    );
    if (cols.length === 0) throw new Error("tickets.sol_handled_at missing after migration");
    const col = cols[0];
    if (col.data_type !== "timestamp with time zone")
      throw new Error(`tickets.sol_handled_at must be timestamptz, got ${col.data_type}`);
    if (col.is_nullable !== "YES")
      throw new Error(`tickets.sol_handled_at must be nullable, got is_nullable=${col.is_nullable}`);
    console.log(`✓ tickets.sol_handled_at present: ${col.data_type} nullable=${col.is_nullable} default=${col.column_default}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
