/**
 * Make the long-declined cohort exhaust on the NEXT cron tick instead of taking one more
 * pointless retry.
 *
 * CEO 2026-09-09: "why even do one more retry on a 10+ decline."
 *
 * PR #2765 seeded these cycles to payday_retry_count = 3 ("one more attempt, then exhaust").
 * With the cap at >= 4 that means Friday 09-11 fires 402 real billing attempts against cards
 * averaging 74 prior declines, and the ladder only runs on the FOLLOWING payday (09-15).
 * That extra round is pure decline volume with a predetermined outcome.
 *
 * Setting count = MAX_PAYDAY_RETRIES and next_retry_at = now() makes the hourly cron select
 * them, hit the cap, and run `exhaustPaydayCycle -> handleAllCardsExhausted` — the real path,
 * so the cancel goes through subscriptionAction() and the customer gets the standard recovery
 * email. Nothing is hand-rolled and no code path is bypassed.
 *
 * Scoped to cycles already escalated to cycle_number >= 2 (i.e. the >= 10-decline cohort from
 * _backfill-dunning-escalate-long-declined.ts), on ACTIVE subs. Cycles below that threshold
 * keep their remaining retries.
 *
 * Reversible until the cron runs: cancel is itself recoverable — Phase 5 reactivates a
 * dunning-cancelled sub as soon as the customer adds a working card.
 *
 * Idempotent. Dry-run by default; --apply to write.
 */
import { pgClient } from "./_bootstrap";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const MAX_PAYDAY_RETRIES = 4;
const APPLY = process.argv.includes("--apply");

const SEL = `
  from dunning_cycles dc join subscriptions s on s.id = dc.subscription_id
  where dc.workspace_id = $1 and dc.status = 'retrying'
    and dc.shopify_contract_id not like 'internal-%'
    and dc.cycle_number >= 2 and s.status = 'active'
    and dc.payday_retry_count < ${MAX_PAYDAY_RETRIES}`;

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const { rows: w } = await c.query(
      `select dunning_cycle_2_action a2 from workspaces where id=$1`, [WS]);
    const { rows } = await c.query(
      `select count(*)::int n, min(dc.payday_retry_count)::int lo, max(dc.payday_retry_count)::int hi ${SEL}`, [WS]);
    console.log(`${rows[0].n} cycle(s) would exhaust on the next cron tick`);
    console.log(`  current payday_retry_count range: ${rows[0].lo}–${rows[0].hi}`);
    console.log(`  cycle_number >= 2 → action on exhaust: ${w[0].a2.toUpperCase()}`);
    console.log(`  each: Appstle cancel + recovery email + dunning:cancelled tag`);
    console.log(`\n  cron cadence is hourly — this fires within the hour once applied.`);
    if (!APPLY) { console.log("\nDRY RUN — re-run with --apply to write."); return; }

    const res = await c.query(
      `update dunning_cycles dc
       set payday_retry_count = ${MAX_PAYDAY_RETRIES}, next_retry_at = now(), updated_at = now()
       from subscriptions s
       where s.id = dc.subscription_id and dc.workspace_id = $1 and dc.status='retrying'
         and dc.shopify_contract_id not like 'internal-%'
         and dc.cycle_number >= 2 and s.status='active'
         and dc.payday_retry_count < ${MAX_PAYDAY_RETRIES}`, [WS]);
    console.log(`\n✓ armed ${res.rowCount} cycle(s) — next hourly tick will cancel + email them`);
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
