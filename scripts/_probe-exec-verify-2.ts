/**
 * _probe-exec-verify-2 — READ-ONLY.
 * A: full appstle_api_calls action_type x success (window).
 * B: completed notes → mapped action type → per-type failure rates vs failed notes.
 * C: partial_refund self-heal note dates (did they predate NO_SELF_HEAL_RETRY?).
 * D: ticket_analyses issues type distribution.
 */
import { pgClient } from "./_bootstrap";

const WINDOW = "2026-04-01";

const MAP: [RegExp, string][] = [
  [/^Action completed: Closed ticket|^Action completed: Deactivated ticket/, "close_ticket"],
  [/^Action completed: Paused for \d+ days/, "pause_timed"],
  [/^Action completed: Paused subscription/, "pause"],
  [/^Action completed: Resumed subscription/, "resume"],
  [/^Action completed: Reactivated subscription/, "reactivate"],
  [/^Action completed: Cancelled subscription/, "cancel"],
  [/^Action completed: Applied loyalty coupon/, "apply_loyalty_coupon"],
  [/^Action completed: Applied coupon/, "apply_coupon"],
  [/^Action completed: Redeemed \d+ points for .* partial refund/, "redeem_points_as_refund"],
  [/^Action completed: Redeemed \d+ points/, "redeem_points"],
  [/^Action completed: Partial refund/, "partial_refund"],
  [/^Action completed: Enrolled in crisis|^Action completed: Flipped auto_readd|auto_readd was already/, "crisis_enroll"],
  [/^Action completed: Triggered bill_now/, "bill_now"],
  [/^Action completed: Swapped/, "swap_variant"],
  [/^Action completed: Updated base price/, "update_line_item_price"],
  [/^Action completed: Changed quantity/, "change_quantity"],
  [/^Action completed: Changed next billing date/, "change_next_date"],
  [/^Action completed: Changed frequency/, "change_frequency"],
  [/^Action completed: Removed/, "remove_item"],
  [/^Action completed: Added/, "add_item"],
  [/address updated/, "update_shipping_address"],
  [/^Action completed: (Return|Created return|Return label)/i, "create_return"],
  [/^Action completed: Skipped/, "skip_next_order"],
  [/^Action completed: Unsubscribed/, "unsubscribe"],
  [/^Action completed: (Replacement|Created replacement)/i, "create_replacement_order"],
  [/^Action completed: Linked/, "link_account_by_email"],
];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const api = await c.query(
      `select action_type, success, count(*)::int as n
       from appstle_api_calls where created_at >= $1 group by 1,2 order by 1,2`, [WINDOW]);
    console.log("A appstle_api_calls (type|success|n):");
    for (const r of api.rows) console.log(`  ${r.action_type} | ${r.success} | ${r.n}`);

    const comp = await c.query(
      `select body from ticket_messages where body like 'Action completed:%' and created_at >= $1`, [WINDOW]);
    const counts = new Map<string, number>();
    const unmapped: string[] = [];
    for (const r of comp.rows) {
      const hit = MAP.find(([re]) => re.test(r.body));
      const t = hit ? hit[1] : "(unmapped)";
      counts.set(t, (counts.get(t) || 0) + 1);
      if (!hit && unmapped.length < 25) unmapped.push(r.body.slice(0, 90));
    }
    console.log("\nB completed notes by mapped type:");
    for (const [t, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${t}: ${n}`);
    console.log("  unmapped samples:"); for (const u of unmapped) console.log(`    ${u}`);

    const heal = await c.query(
      `select created_at, ticket_id, left(body,120) as b from ticket_messages
       where body like '[Self-heal]%' and body ilike '%refund%' order by created_at`);
    console.log("\nC partial_refund self-heal notes (all time):");
    for (const r of heal.rows) console.log(`  ${r.created_at.toISOString()} ${r.ticket_id} ${r.b}`);

    const iss = await c.query(
      `select i->>'type' as itype, count(*)::int as n
       from ticket_analyses ta, jsonb_array_elements(ta.issues) i
       where ta.created_at >= $1
       group by 1 order by n desc`, [WINDOW]);
    console.log("\nD ticket_analyses issue types since window:");
    for (const r of iss.rows) console.log(`  ${r.itype}: ${r.n}`);

    const tot = await c.query(
      `select count(*)::int as analyses, count(distinct ticket_id)::int as tickets from ticket_analyses where created_at >= $1`, [WINDOW]);
    console.log("analyses total:", JSON.stringify(tot.rows[0]));

    // sample one issue object to see shape
    const sample = await c.query(
      `select ta.ticket_id, i as issue from ticket_analyses ta, jsonb_array_elements(ta.issues) i
       where i->>'type' in ('broken_action','false_promise') and ta.created_at >= $1 limit 3`, [WINDOW]);
    console.log("\nD2 sample issue objects:");
    for (const r of sample.rows) console.log(`  ${r.ticket_id}: ${JSON.stringify(r.issue).slice(0, 400)}`);
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
