/**
 * Apply 20261020120000_creative_skeletons_product_competitor.sql to the pooler:
 * add competitor_id + product_id to creative_skeletons, index them, and clear the
 * 473 pre-refactor rows (all product_id null). Reports before/after counts.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { loadEnv, pgClient } from "./_bootstrap";
loadEnv();

async function main() {
  const sql = readFileSync(
    join(__dirname, "../supabase/migrations/20261020120000_creative_skeletons_product_competitor.sql"),
    "utf8",
  );
  const c = pgClient();
  await c.connect();
  try {
    const before = await c.query(`select count(*)::int as n from public.creative_skeletons`);
    console.log(`before: ${before.rows[0].n} skeleton rows`);
    await c.query(sql);
    const after = await c.query(`select count(*)::int as n from public.creative_skeletons`);
    console.log(`after:  ${after.rows[0].n} skeleton rows (cleared ${before.rows[0].n - after.rows[0].n})`);
    const cols = await c.query(
      `select column_name from information_schema.columns
       where table_name='creative_skeletons' and column_name in ('competitor_id','product_id')
       order by column_name`,
    );
    console.log("new columns:", cols.rows.map((r) => r.column_name).join(", ") || "(none — FAILED)");
  } finally {
    await c.end();
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
