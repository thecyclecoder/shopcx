import { pgClient } from "./_bootstrap";
async function main() {
  const c = pgClient(); await c.connect();
  try {
    const ev = await c.query(`select created_at, summary from customer_events where event_type='order.refunded' and summary like 'Refund $%issued via%' order by created_at`);
    console.log("A refundOrder-authored events (all time):");
    for (const r of ev.rows) console.log(`  ${r.created_at.toISOString()} ${String(r.summary).slice(0,100)}`);

    const t = await c.query(`select count(*)::int as n from tickets where created_at >= '2026-04-01' and merged_into is null`);
    const tc = await c.query(`select count(distinct t.id)::int as n from tickets t join ticket_messages m on m.ticket_id=t.id and m.author_type='ai' and m.direction='outbound' where t.created_at >= '2026-04-01' and t.merged_into is null and t.status='closed'`);
    console.log(`\nB tickets since 4/1 (merged_into null): ${t.rows[0].n}; closed-with-AI-outbound: ${tc.rows[0].n}`);

    const ret = await c.query(`select count(*)::int as n, count(refunded_at)::int as refunded, count(refund_id)::int as with_id from returns where created_at >= '2026-04-01'`);
    console.log(`C returns since 4/1: ${JSON.stringify(ret.rows[0])}`);

    const rid = await c.query(`select refund_id, count(*)::int n from returns where refunded_at >= '2026-04-01' group by 1 order by n desc limit 10`);
    console.log("C2 returns.refund_id values:"); for (const r of rid.rows) console.log(`  ${String(r.refund_id).slice(0,30)}: ${r.n}`);

    // notes: braintree-direct vs shopify in the completed-note text
    const m = await c.query(`select count(*) filter (where body like '%refunded directly via Braintree%')::int as bt_direct,
      count(*) filter (where body like '%txn %')::int as with_txn, count(*)::int as total
      from ticket_messages where body like 'Action completed: Partial refund%' and created_at >= '2026-04-01'`);
    console.log(`D refund notes: ${JSON.stringify(m.rows[0])}`);
  } finally { await c.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
