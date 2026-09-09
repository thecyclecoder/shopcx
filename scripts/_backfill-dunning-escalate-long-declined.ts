/**
 * Escalate long-declining dunning cycles from cycle 1 to cycle 2, so exhaustion CANCELS
 * instead of running a pointless skip.
 *
 * CEO call 2026-09-09: "if someone has like 10+ declines, the skip is pointless."
 *
 * Why their cycle_number is wrong. The payday-retry cron never applied the cycle ladder at
 * all (handleAllCardsExhausted was only reachable from the card-rotation flow), and the
 * retry cap was unenforced, so cycles never closed and nobody was ever escalated. The fleet
 * shows 1,357 cycles at cycle_number=1 against 123 at 2 — not because customers recover, but
 * because the ladder was unreachable. cycle_number here is an artifact of two bugs, not a
 * record of how much dunning a customer has actually received.
 *
 * Measured on the 387 cycles about to exhaust on 2026-09-11:
 *   385 have >= 10 declines · 339 have >= 50 · avg 74 declines each · max 212
 *   avg 136 days open · max 165 (5.5 months without a successful charge)
 *
 * Cancel is the right terminal action AND it is reversible: dunning-new-card-recovery
 * deliberately includes `exhausted` cycles, so a dunning-cancelled sub REACTIVATES when the
 * customer adds a working card (lifecycles/dunning.md Phase 5). Cancel means "stop trying
 * until you fix your card", not goodbye.
 *
 * Threshold is declines, not age — a sub that failed 60 times has had its dunning regardless
 * of which cycle number the bug left it on. Cycles below the threshold keep the ordinary skip.
 *
 * Idempotent: only raises cycle_number, never lowers it, and skips rows already >= 2.
 * Dry-run by default; --apply to write.
 *
 * Run: npx tsx scripts/_backfill-dunning-escalate-long-declined.ts [--apply]
 */
import { pgClient } from "./_bootstrap";

const MIN_DECLINES = 10;
const APPLY = process.argv.includes("--apply");

const CANDIDATES = `
  select dc.id, dc.shopify_contract_id, dc.cycle_number, dc.payday_retry_count,
         (extract(epoch from (now() - dc.created_at)) / 86400)::int days_open,
         (select count(*) from payment_failures pf
           where pf.subscription_id = dc.subscription_id
             and pf.created_at >= dc.created_at and pf.result = 'failed') declines
  from dunning_cycles dc
  join subscriptions s on s.id = dc.subscription_id
  where dc.status = 'retrying' and dc.cycle_number < 2 and s.status = 'active'`;

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const { rows } = await c.query(`${CANDIDATES} order by declines desc`);
    const hits = rows.filter((r) => Number(r.declines) >= MIN_DECLINES);
    console.log(`${rows.length} open cycle(s) at cycle_number < 2 on an active sub`);
    console.log(`${hits.length} with >= ${MIN_DECLINES} declines → escalate to cycle 2 (cancel on exhaust)`);
    console.log(`${rows.length - hits.length} below the threshold → keep the ordinary skip\n`);
    const b = new Map<string, number>();
    for (const r of rows) {
      const d = Number(r.declines);
      const k = d < 5 ? "  <5" : d < 10 ? " 5-9" : d < 20 ? "10-19" : d < 50 ? "20-49" : "  50+";
      b.set(k, (b.get(k) ?? 0) + 1);
    }
    console.log("  declines  cycles");
    for (const [k, n] of [...b].sort()) console.log(`  ${k}      ${n}`);

    if (!APPLY) { console.log("\nDRY RUN — re-run with --apply to write."); return; }

    const res = await c.query(
      `update dunning_cycles dc set cycle_number = 2, updated_at = now()
       from subscriptions s
       where s.id = dc.subscription_id and dc.id = any($1::uuid[])
         and dc.cycle_number < 2 and dc.status = 'retrying' and s.status = 'active'`,
      [hits.map((h) => h.id)],
    );
    console.log(`\n✓ escalated ${res.rowCount} cycle(s) to cycle_number = 2`);
    const { rows: chk } = await c.query(
      `select cycle_number, count(*)::int n from dunning_cycles where status='retrying' group by 1 order by 1`,
    );
    for (const r of chk) console.log(`  retrying at cycle_number=${r.cycle_number}: ${r.n}`);
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
