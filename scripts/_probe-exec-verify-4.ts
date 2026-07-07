/**
 * _probe-exec-verify-4 — READ-ONLY.
 * A: refined per-issue classification of broken_action/false_promise.
 * B: refund deep-dive — every refund told-to-customer vs gateway evidence.
 */
import { pgClient } from "./_bootstrap";
const WINDOW = "2026-04-01";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const rows = await c.query(
      `with iss as (
         select ta.ticket_id, i->>'type' as itype, i->>'description' as descr
         from ticket_analyses ta, jsonb_array_elements(ta.issues) i
         where ta.created_at >= $1 and i->>'type' in ('broken_action','false_promise')
       ), dedup as (select distinct ticket_id, itype, descr from iss)
       select d.*,
         (select count(*)::int from ticket_messages tm where tm.ticket_id=d.ticket_id and tm.body like 'Action failed:%') as n_failed
       from dedup d`, [WINDOW]);

    const cls = (descr: string, nFailed: number): string => {
      const s = descr.toLowerCase();
      if (/still active in our db|silent no-op|did not fire/.test(s)) return "B_state_divergence";
      if (/\{\{|unrendered|template (token|variable)|placeholder|\[date\]|\[amount\]|clickable|plain hyperlink/.test(s)) return "R_rendering_binding";
      if (/refund/.test(s)) {
        if (/no (refund |matching |corresponding )?action|not (actually )?(executed|processed|issued)|never (executed|processed|issued)|without.*action|no action/.test(s)) return "D_refund_claim_no_action";
        if (/failed|pending|did not move|error/.test(s) || nFailed > 0) return "D_refund_attempt_failed";
        return "D_refund_other";
      }
      if (/(action )?failed|400|405|error/.test(s) && nFailed > 0) return "A_attempted_failed";
      if (/no (corresponding|matching|visible|such|cancel|subscription|system)?\s*action|not executed|never executed|no action was|without (any )?(matching |system |corresponding )?action|but no .*(action|actions)|no .* action was/.test(s)) return "C_claim_no_action";
      if (/follow up|reach out|get back to you|be in touch|business day|24 hours|call(back)?|will email|we'll follow/.test(s)) return "C_unactionable_promise";
      if (/wrong|mismatch|different|contradict|instead of|but the actual/.test(s)) return "B_wrong_effect";
      return "U_other";
    };

    const counts = new Map<string, number>();
    const samples = new Map<string, string[]>();
    for (const r of rows.rows) {
      const k = cls(r.descr || "", r.n_failed);
      counts.set(k, (counts.get(k) || 0) + 1);
      if (!samples.has(k)) samples.set(k, []);
      if (samples.get(k)!.length < 6) samples.get(k)!.push(`${r.ticket_id} [${r.itype}] ${String(r.descr).slice(0, 130)}`);
    }
    console.log(`A refined classification of ${rows.rows.length} issues:`);
    for (const [k, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
    for (const [k, ss] of samples) { console.log(`\n-- ${k}`); for (const s of ss) console.log("   " + s); }

    // ── B. refund deep-dive ──
    const ev = await c.query(
      `select ce.created_at, ce.customer_id, ce.summary,
              ce.properties->>'order_number' as order_number,
              ce.properties->>'order_id' as order_id,
              ce.properties->>'method' as method,
              ce.properties->>'refund_id' as refund_id,
              ce.properties->>'amount_cents' as amount_cents,
              ce.source
       from customer_events ce
       where ce.event_type='order.refunded' and ce.created_at >= $1
       order by ce.created_at`, [WINDOW]);
    console.log(`\nB1 order.refunded events since ${WINDOW}: ${ev.rows.length}`);
    let bt = 0, sh = 0, noId = 0;
    for (const r of ev.rows) {
      if (r.method === "braintree") bt++; else sh++;
      if (!r.refund_id || r.refund_id === "direct_refund") noId++;
    }
    console.log(`   method braintree=${bt} shopify=${sh}; missing/placeholder refund_id=${noId}`);

    // financial_status of refunded orders (would DB-verify have passed?)
    const fs = await c.query(
      `select o.financial_status, count(*)::int as n
       from customer_events ce join orders o on o.id = (ce.properties->>'order_id')::uuid
       where ce.event_type='order.refunded' and ce.created_at >= $1
       group by 1 order by n desc`, [WINDOW]);
    console.log("B2 financial_status of orders with order.refunded events:");
    for (const r of fs.rows) console.log(`   ${r.financial_status}: ${r.n}`);

    // refunds told to customer (completed notes) vs events — coverage check
    const notes = await c.query(
      `select tm.ticket_id, tm.created_at, left(tm.body, 130) as body
       from ticket_messages tm
       where (tm.body like 'Action completed: Partial refund%' or tm.body like 'Action completed: Redeemed%partial refund%')
         and tm.created_at >= $1 order by tm.created_at`, [WINDOW]);
    console.log(`\nB3 refund 'Action completed' notes: ${notes.rows.length}`);
    // match each note to an event within 10 min
    let matched = 0;
    const unmatched: string[] = [];
    for (const n of notes.rows) {
      const hit = ev.rows.find(e => Math.abs(new Date(e.created_at).getTime() - new Date(n.created_at).getTime()) < 10 * 60 * 1000);
      if (hit) matched++; else if (unmatched.length < 10) unmatched.push(`${n.ticket_id} ${n.created_at.toISOString()} ${n.body}`);
    }
    console.log(`   matched to an order.refunded event (±10min): ${matched}/${notes.rows.length}`);
    for (const u of unmatched) console.log("   UNMATCHED: " + u);

    // events with no refund_id → gateway evidence absent
    const noid = await c.query(
      `select ce.created_at, ce.summary, ce.properties->>'refund_id' as refund_id, ce.properties->>'method' as method
       from customer_events ce
       where ce.event_type='order.refunded' and ce.created_at >= $1
         and (ce.properties->>'refund_id' is null or ce.properties->>'refund_id'='direct_refund')
       order by ce.created_at limit 20`, [WINDOW]);
    console.log(`\nB4 refund events lacking a gateway refund_id: ${noid.rows.length}`);
    for (const r of noid.rows) console.log(`   ${r.created_at.toISOString()} [${r.method}] ${String(r.summary).slice(0, 110)}`);
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
