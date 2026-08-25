/**
 * Nudge PostgREST to reload its schema cache after a hand-applied migration.
 *
 * Supabase's REST layer caches the table/column catalogue; a column added by direct SQL is invisible
 * to `admin.from(...)` until the cache refreshes ("Could not find the 'x' column ... in the schema
 * cache"). `notify pgrst, 'reload schema'` is the sanctioned nudge.
 */
import { pgClient } from "./_bootstrap";

const TABLE = process.argv[2] ?? "products";
const COLUMN = process.argv[3] ?? "competitor_shelf_source_id";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const r = await c.query(
      "select column_name from information_schema.columns where table_schema='public' and table_name=$1 and column_name=$2",
      [TABLE, COLUMN],
    );
    console.log(`${TABLE}.${COLUMN} present in the catalog: ${r.rowCount === 1}`);
    await c.query("notify pgrst, 'reload schema'");
    console.log("sent: notify pgrst, 'reload schema'");
  } finally {
    await c.end();
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
