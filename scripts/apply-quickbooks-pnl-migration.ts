// apply-quickbooks-pnl-migration — creates quickbooks_connections + qb_pnl_snapshots
// (CFO / QuickBooks P&L snapshot work). Idempotent. See docs/brain/tables/qb_pnl_snapshots.md.
//   npx tsx scripts/apply-quickbooks-pnl-migration.ts
import { pgClient } from "./_bootstrap";
import { readFileSync } from "fs";
import { resolve } from "path";

async function main() {
  const sql = readFileSync(resolve(__dirname, "../supabase/migrations/20261010120000_quickbooks_pnl.sql"), "utf8");
  const c = pgClient();
  await c.connect();
  try {
    await c.query(sql);
    console.log("✓ migration applied");
    const { rows } = await c.query(
      `select table_name, count(*) as cols from information_schema.columns
        where table_schema='public' and table_name in ('quickbooks_connections','qb_pnl_snapshots')
        group by table_name order by table_name`,
    );
    console.log(rows);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
