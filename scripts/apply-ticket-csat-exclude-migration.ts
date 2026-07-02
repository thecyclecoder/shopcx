// apply-ticket-csat-exclude-migration — add excluded_at / excluded_by /
// exclusion_reason to ticket_csat (csat-owner-exclude-from-stats Phase 1).
// Idempotent (ADD COLUMN IF NOT EXISTS).
//   npx tsx scripts/apply-ticket-csat-exclude-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260811120000_ticket_csat_exclude.sql"];

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
        where table_name='ticket_csat'
          and column_name in ('excluded_at','excluded_by','exclusion_reason')
        order by column_name`,
    );
    for (const r of cols) {
      console.log(`✓ ticket_csat.${r.column_name}: ${r.data_type} nullable=${r.is_nullable}`);
    }
    if (cols.length !== 3) {
      throw new Error(`expected 3 new columns on ticket_csat, saw ${cols.length}`);
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
