/**
 * Seed `dunning_cycles.payday_retry_count` for cycles that pre-date the cap.
 *
 * PR #2764 added the cap but deliberately left existing cycles at 0, to avoid pushing ~509
 * cycles past it on one tick and firing a 400+ customer payment-recovery email blast in a
 * single batch. That was the right instinct about the blast and the wrong number: a cycle
 * that already made 170 attempts should not be granted 4 more.
 *
 * Seed = least(payday retries already made, MAX_PAYDAY_RETRIES - 1), so:
 *   - a runaway cycle gets exactly ONE more attempt, then exhausts and runs the final
 *     actions (closing email + cycle action) it never reached
 *   - a cycle partway through its legitimate 4 keeps the remainder
 *   - a fresh cycle is untouched
 *
 * Measured 2026-09-09 across 420 live 'retrying' cycles: 389 already over the cap
 * (avg 35.6 attempts, worst 170). Seeding cuts remaining attempts from ~1,680 to ~499.
 *
 * payment_failures has no cycle_id, so retries are scoped by (subscription_id, created_at
 * >= cycle.created_at) — the cycle's own lifetime.
 *
 * Idempotent: only touches rows still at 0, so a re-run after the cap starts incrementing
 * is a no-op. Dry-run by default; pass --apply to write.
 *
 * Run: npx tsx scripts/_backfill-dunning-payday-retry-count.ts [--apply]
 */
import { pgClient } from "./_bootstrap";

const MAX_PAYDAY_RETRIES = 4;
const APPLY = process.argv.includes("--apply");

const SELECT = `
  with live as (
    select id, subscription_id, created_at, shopify_contract_id
    from dunning_cycles
    where status = 'retrying' and payday_retry_count = 0
  )
  select l.id, l.shopify_contract_id,
    (select count(*) from payment_failures pf
      where pf.subscription_id = l.subscription_id
        and pf.attempt_type = 'payday_retry'
        and pf.created_at >= l.created_at) retries_done
  from live l`;

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const { rows } = await c.query(SELECT);
    const plan = rows.map((r) => ({
      id: r.id,
      contract: r.shopify_contract_id,
      done: Number(r.retries_done),
      seed: Math.min(Number(r.retries_done), MAX_PAYDAY_RETRIES - 1),
    }));
    const buckets = new Map<number, number>();
    for (const p of plan) buckets.set(p.seed, (buckets.get(p.seed) ?? 0) + 1);
    console.log(`${plan.length} cycle(s) to seed\n`);
    console.log("  seed  attempts left  cycles");
    for (const [seed, n] of [...buckets].sort((a, b) => a[0] - b[0]))
      console.log(`  ${seed}     ${MAX_PAYDAY_RETRIES - seed}              ${n}`);
    console.log(`\n  remaining attempts after seeding: ${plan.reduce((a, p) => a + (MAX_PAYDAY_RETRIES - p.seed), 0)}`);
    console.log(`  (without seeding, all would get ${MAX_PAYDAY_RETRIES} → ${plan.length * MAX_PAYDAY_RETRIES})`);

    if (!APPLY) { console.log("\nDRY RUN — re-run with --apply to write."); return; }

    let n = 0;
    for (const p of plan) {
      const res = await c.query(
        `update dunning_cycles set payday_retry_count = $2, updated_at = now()
         where id = $1 and payday_retry_count = 0`,
        [p.id, p.seed],
      );
      n += res.rowCount ?? 0;
    }
    console.log(`\n✓ seeded ${n} cycle(s)`);
    const { rows: chk } = await c.query(
      `select payday_retry_count, count(*)::int n from dunning_cycles
       where status='retrying' group by 1 order by 1`,
    );
    for (const r of chk) console.log(`  payday_retry_count=${r.payday_retry_count}: ${r.n} cycle(s)`);
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
