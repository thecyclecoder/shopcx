/**
 * _probe-exec-verify-5 — READ-ONLY refund ground-truth probe.
 * A: refundOrder-authored order.refunded events (summary 'Refund $... issued via ...').
 * B: match the 34 refund completed-notes to those events; financial_status check.
 * C: case-study message timelines.
 */
import { pgClient } from "./_bootstrap";
const WINDOW = "2026-04-01";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const ev = await c.query(
      `select ce.created_at, ce.customer_id, ce.summary,
              ce.properties->>'order_id' as order_id,
              ce.properties->>'method' as method,
              ce.properties->>'refund_id' as refund_id,
              (ce.properties->>'amount_cents')::int as amount_cents
       from customer_events ce
       where ce.event_type='order.refunded' and ce.created_at >= $1
         and ce.summary like 'Refund $%issued via%'
       order by ce.created_at`, [WINDOW]);
    let bt = 0, sh = 0, btNoId = 0;
    for (const r of ev.rows) { if (r.method === "braintree") { bt++; if (!r.refund_id) btNoId++; } else sh++; }
    console.log(`A refundOrder-authored events: ${ev.rows.length} (braintree=${bt}, shopify=${sh}, braintree-missing-refund_id=${btNoId})`);

    const fs = await c.query(
      `select o.financial_status, count(*)::int as n
       from customer_events ce join orders o on o.id = (ce.properties->>'order_id')::uuid
       where ce.event_type='order.refunded' and ce.created_at >= $1
         and ce.summary like 'Refund $%issued via%'
       group by 1 order by n desc`, [WINDOW]);
    console.log("A2 financial_status of those orders NOW (would DB-verify pass?):");
    for (const r of fs.rows) console.log(`   ${r.financial_status}: ${r.n}`);

    // B: match completed notes → events by ticket customer + time
    const notes = await c.query(
      `select tm.ticket_id, tm.created_at, left(tm.body,120) as body, t.customer_id
       from ticket_messages tm join tickets t on t.id = tm.ticket_id
       where (tm.body like 'Action completed: Partial refund%' or tm.body like 'Action completed: Redeemed%partial refund%')
         and tm.created_at >= $1 order by tm.created_at`, [WINDOW]);
    let matched = 0, btM = 0, shM = 0, withId = 0;
    const unmatched: string[] = [];
    const matchedOrders: string[] = [];
    for (const n of notes.rows) {
      const hit = ev.rows.find(e =>
        (!n.customer_id || !e.customer_id || e.customer_id === n.customer_id) &&
        Math.abs(new Date(e.created_at).getTime() - new Date(n.created_at).getTime()) < 10 * 60 * 1000);
      if (hit) { matched++; if (hit.method === "braintree") btM++; else shM++; if (hit.refund_id) withId++; if (hit.order_id) matchedOrders.push(hit.order_id); }
      else unmatched.push(`${n.ticket_id} ${n.created_at.toISOString()} ${n.body}`);
    }
    console.log(`\nB notes=${notes.rows.length} matched=${matched} (braintree=${btM}, shopify=${shM}, with refund_id=${withId})`);
    console.log("  unmatched (no refundOrder event found — check writer):");
    for (const u of unmatched) console.log("   " + u);
    if (matchedOrders.length) {
      const fs2 = await c.query(
        `select financial_status, count(*)::int as n from orders where id = any($1::uuid[]) group by 1`, [matchedOrders]);
      console.log("B2 financial_status of ticket-matched refunded orders:");
      for (const r of fs2.rows) console.log(`   ${r.financial_status}: ${r.n}`);
    }

    // C: case studies
    for (const tid of ["d8f67eef-dd67-4903-9008-fb55c0e83788", "361e4b72-9604-4dfe-8b85-eea926f9a026", "03e9d016-91dd-4586-9bdf-72d32890de3b"]) {
      const msgs = await c.query(
        `select created_at, author_type, direction, visibility, left(coalesce(body_clean, body), 170) as b
         from ticket_messages where ticket_id=$1 order by created_at`, [tid]);
      console.log(`\nC timeline ${tid}:`);
      for (const m of msgs.rows) console.log(`  ${m.created_at.toISOString()} ${m.author_type}/${m.direction}/${m.visibility}: ${String(m.b).replace(/\n/g, " ")}`);
    }
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
