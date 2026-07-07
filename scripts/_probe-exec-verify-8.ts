import { pgClient } from "./_bootstrap";
async function main() {
  const c = pgClient(); await c.connect();
  try {
    const cols = await c.query(`select column_name from information_schema.columns where table_schema='public' and table_name='orders' and (column_name ilike '%refund%' or column_name ilike '%financial%' or column_name ilike '%total%')`);
    console.log("orders money cols:", cols.rows.map(r=>r.column_name).join(", "));
    const o = await c.query(`select order_number, financial_status, total_cents, braintree_transaction_id is not null as has_bt from orders where order_number in ('SC132306','SC129432','SC132396')`);
    for (const r of o.rows) console.log(JSON.stringify(r));
    const rt = await c.query(`select table_name from information_schema.tables where table_schema='public' and table_name ilike '%refund%'`);
    console.log("refund tables:", rt.rows.map(r=>r.table_name).join(", ") || "(none)");
  } finally { await c.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
