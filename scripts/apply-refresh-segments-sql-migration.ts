// apply-refresh-segments-sql-migration — install the set-based refresh_customer_segments()
// function (migration 20260704160000). Runs the whole file in one query (the plpgsql $$ body
// contains semicolons, so it must NOT be split statement-by-statement). Then smoke-tests the
// function on the Superfoods workspace and reports timing + coverage.
//   npx tsx scripts/apply-refresh-segments-sql-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260704160000_refresh_segments_sql.sql";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

function verdict(line: string) { console.log(`>>> APPLY RESULT: ${line}`); console.error(`>>> APPLY RESULT: ${line}`); }

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const sql = readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8");
    await c.query(sql);
    console.log(`✓ applied ${MIGRATION} (function + grant)`);

    // smoke-test: time a full subscribed-scope refresh
    const t0 = Date.now();
    const { rows } = await c.query("select public.refresh_customer_segments($1, false) as n", [WS]);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const updated = rows[0].n;

    // coverage check: how many subscribable customers are now fresh (<2 min)
    const { rows: cov } = await c.query(
      `select count(*) filter (where segments_refreshed_at > now() - interval '2 minutes') fresh, count(*) total
       from customers where workspace_id=$1 and sms_marketing_status='subscribed' and phone is not null`, [WS]);
    await c.end();
    verdict(`OK — refresh_customer_segments updated ${updated} rows in ${secs}s. Coverage now: ${cov[0].fresh}/${cov[0].total} subscribable fresh (<2min).`);
  } catch (e: any) {
    verdict(`FAILED — ${e?.code ? `code=${e.code} ` : ""}${String(e?.message || e).slice(0, 200)}`);
    await c.end().catch(() => {});
    process.exit(1);
  }
}
main().then(() => process.exit(0)).catch((e) => { verdict(`fatal — ${String(e).slice(0,160)}`); process.exit(1); });
