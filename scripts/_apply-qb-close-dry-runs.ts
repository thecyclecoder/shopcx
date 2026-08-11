import { pgClient } from "./_bootstrap";
import { readFileSync } from "fs";
import { resolve } from "path";

async function main() {
  const sql = readFileSync(resolve(__dirname, "../supabase/migrations/20261213130000_qb_close_dry_runs.sql"), "utf8");
  const c = pgClient();
  await c.connect();
  try {
    await c.query(sql);
    const { rows } = await c.query(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='qb_close_dry_runs' order by ordinal_position`,
    );
    console.log(`✓ qb_close_dry_runs applied — ${rows.length} cols`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
