// apply-specs-card-state-columns-migration — spec-fold-from-db-row Phase 2 (expand step). Adds the six
// surviving spec_card_state fields as typed nullable columns on public.specs + backfills them in one
// migration. Idempotent — re-running is safe (IF NOT EXISTS + coalesce-style backfill).
// Run against the pooler:
//   npx tsx scripts/apply-specs-card-state-columns-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260725140000_specs_card_state_columns.sql"];

const NEW_COLUMNS = [
  "last_merge_sha",
  "short_circuit",
  "short_circuit_reason",
  "vale_pass",
  "ada_disposition",
  "merged_pr",
];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='specs' and column_name = any($1::text[])
        order by column_name`,
      [NEW_COLUMNS],
    );
    const present = new Set(rows.map((r: { column_name: string }) => r.column_name));
    for (const col of NEW_COLUMNS) {
      console.log(`  ${present.has(col) ? "✓" : "✗"} specs.${col}`);
    }
    const { rows: counts } = await c.query(
      `select
         count(*) filter (where last_merge_sha is not null)       as last_merge_sha_n,
         count(*) filter (where short_circuit is not null)        as short_circuit_n,
         count(*) filter (where short_circuit_reason is not null) as short_circuit_reason_n,
         count(*) filter (where vale_pass is not null)            as vale_pass_n,
         count(*) filter (where ada_disposition is not null)      as ada_disposition_n,
         count(*) filter (where merged_pr is not null)            as merged_pr_n,
         count(*)                                                  as total_specs
       from public.specs`,
    );
    console.log(`✓ backfill: ${JSON.stringify(counts[0])}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
