import { pgClient } from "./_bootstrap";
import { readFileSync } from "fs";
import { resolve } from "path";

async function main() {
  const sql = readFileSync(
    resolve(__dirname, "../supabase/migrations/20261213120001_qb_close_source_tables.sql"),
    "utf8",
  );
  const c = pgClient();
  await c.connect();
  try {
    await c.query(sql);
    console.log("✓ migration applied");
    const { rows } = await c.query(
      `select table_name,
              (select count(*) from information_schema.columns col
                where col.table_schema='public' and col.table_name=t.table_name) as cols
         from information_schema.tables t
        where table_schema='public' and table_name like 'qb_%'
        order by table_name`,
    );
    for (const r of rows) console.log(`  ${String(r.table_name).padEnd(36)} ${r.cols} cols`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
