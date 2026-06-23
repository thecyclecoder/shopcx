/**
 * One-time backlog prune of loop_heartbeats (loop-heartbeats-retention spec, Phase 1).
 *
 * loop_heartbeats grew to ~21M rows / 4.5 GB with no retention, timing out the
 * control_tower_loop_beats RPC (57014) and blinding the Control Tower. The new daily
 * `loop-heartbeats-prune` cron prevents recurrence, but it deletes in capped batches and
 * would take days to chew through a 21M-row backlog. This script clears that backlog in
 * one supervised pass:
 *
 *   1) ctid-batched DELETE of every beat older than RETENTION_DAYS — small autocommit
 *      statements (each its own implicit txn) so no single long lock on the table.
 *   2) VACUUM (ANALYZE) to reclaim the dead-tuple space AND refresh the planner stats so
 *      the lateral + partial-index plan the RPC relies on is chosen.
 *
 * Run ONCE, out-of-band, with owner authorization (this is a prod mutation):
 *   npx tsx scripts/prune-loop-heartbeats-backlog.ts
 *
 * Idempotent + safe to re-run: a second run finds nothing older than the cutoff and just
 * re-VACUUMs. The daily cron keeps the table bounded afterward.
 *
 * NOTE: VACUUM cannot run inside a transaction block and is unsupported on the transaction
 * pooler (:6543), so this script connects via the SESSION pooler (:5432).
 */
import { loadEnv } from "./_bootstrap";
import { Client } from "pg";

const RETENTION_DAYS = 3;
const BATCH_SIZE = 10_000;
const PROJECT_REF = "urjbhjbygyxffrfkarqn";

/** Session-pooler (:5432) connection string — VACUUM needs a session, not the txn pooler (:6543). */
function sessionConnectionString(): string {
  loadEnv();
  // An explicit session URL wins if provided.
  if (process.env.SUPABASE_DB_SESSION_URL) return process.env.SUPABASE_DB_SESSION_URL;
  const password = process.env.SUPABASE_DB_PASSWORD;
  if (!password) {
    throw new Error(
      "SUPABASE_DB_PASSWORD is not set (and no SUPABASE_DB_SESSION_URL). " +
        "Locally: add it to .env.local. On the box: it comes from the systemd EnvironmentFile.",
    );
  }
  const host = process.env.SUPABASE_DB_HOST || "aws-1-us-east-1.pooler.supabase.com";
  return `postgres://postgres.${PROJECT_REF}:${encodeURIComponent(password)}@${host}:5432/postgres`;
}

async function main() {
  const c = new Client({ connectionString: sessionConnectionString() });
  await c.connect();
  try {
    const { rows: before } = await c.query<{ n: string }>(
      "select count(*)::bigint as n from public.loop_heartbeats",
    );
    console.log(`loop_heartbeats rows before: ${before[0].n}`);

    // 1) ctid-batched delete — bounded statements, no one long lock.
    let totalDeleted = 0;
    let batch = 0;
    for (;;) {
      const { rowCount } = await c.query(
        `delete from public.loop_heartbeats
         where ctid in (
           select ctid from public.loop_heartbeats
           where ran_at < now() - interval '${RETENTION_DAYS} days'
           limit ${BATCH_SIZE}
         )`,
      );
      const n = rowCount ?? 0;
      totalDeleted += n;
      batch++;
      if (batch % 25 === 0 || n < BATCH_SIZE) {
        console.log(`  batch ${batch}: deleted ${n} (running total ${totalDeleted})`);
      }
      if (n < BATCH_SIZE) break;
    }
    console.log(`✓ deleted ${totalDeleted} beats older than ${RETENTION_DAYS} days in ${batch} batches`);

    // 2) reclaim space + refresh planner stats.
    console.log("running VACUUM (ANALYZE) public.loop_heartbeats …");
    await c.query("vacuum (analyze) public.loop_heartbeats");
    console.log("✓ vacuum analyze complete");

    const { rows: after } = await c.query<{ n: string }>(
      "select count(*)::bigint as n from public.loop_heartbeats",
    );
    console.log(`loop_heartbeats rows after: ${after[0].n}`);

    // Smoke-test the RPC now rides the index and returns well under the statement timeout.
    const t0 = Date.now();
    const { rows: beats } = await c.query<{ n: number }>(
      "select count(*)::int as n from public.control_tower_loop_beats(20)",
    );
    console.log(`✓ control_tower_loop_beats(20) returned ${beats[0].n} rows in ${Date.now() - t0}ms`);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
