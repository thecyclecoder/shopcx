/**
 * Close open dunning cycles whose subscription is already paused or cancelled.
 *
 * CEO rule (2026-09-09): "a pause or cancellation should end your dunning experience."
 * The code fix closes cycles at pause/cancel time going forward; these pre-date it.
 *
 * Found 2026-09-09: 9 paused + 3 cancelled subs sitting in status='retrying'. The payday
 * cron only gated on "cancelled", so the paused ones kept being retried — and 4 of them
 * were in the 2026-09-11 cohort about to receive a "your payment failed, update your card"
 * email for a subscription they had deliberately paused (one until 2026-10-30).
 *
 * Only touches cycles still OPEN (active/rotating/retrying/skipped). A cycle dunning itself
 * drove to 'exhausted' is left alone, preserving the deliberate behaviour that adding a card
 * to a DUNNING-cancelled sub reactivates it (lifecycles/dunning.md Phase 5).
 *
 * Idempotent — re-running finds nothing once closed. Dry-run by default; --apply to write.
 *
 * Run: npx tsx scripts/_backfill-end-dunning-on-paused-cancelled.ts [--apply]
 */
import { pgClient } from "./_bootstrap";

const APPLY = process.argv.includes("--apply");
const OPEN = "('active','rotating','retrying','skipped')";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const { rows } = await c.query(`
      select dc.id, dc.shopify_contract_id, dc.status cycle_status, dc.payday_retry_count,
             s.status sub_status, dc.created_at::date::text opened
      from dunning_cycles dc join subscriptions s on s.id = dc.subscription_id
      where dc.status in ${OPEN} and s.status in ('paused','cancelled')
      order by s.status, dc.created_at`);
    console.log(`${rows.length} open cycle(s) on a paused/cancelled subscription\n`);
    for (const r of rows)
      console.log(`  ${String(r.sub_status).padEnd(10)} ${String(r.shopify_contract_id).padEnd(14)} cycle=${String(r.cycle_status).padEnd(9)} retries=${r.payday_retry_count} opened ${r.opened}`);

    if (!APPLY) { console.log("\nDRY RUN — re-run with --apply to write."); return; }

    const res = await c.query(`
      update dunning_cycles dc
      set status = 'exhausted', next_retry_at = null,
          terminal_error_code = 'subscription_' || s.status, updated_at = now()
      from subscriptions s
      where s.id = dc.subscription_id
        and dc.status in ${OPEN} and s.status in ('paused','cancelled')`);
    console.log(`\n✓ closed ${res.rowCount} cycle(s)`);
    const { rows: left } = await c.query(`
      select count(*)::int n from dunning_cycles dc join subscriptions s on s.id = dc.subscription_id
      where dc.status in ${OPEN} and s.status in ('paused','cancelled')`);
    console.log(`✓ remaining open cycles on paused/cancelled subs: ${left[0].n}`);
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
