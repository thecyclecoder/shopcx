/**
 * Applies 20261122120000_agent_jobs_queued_claim_idx_and_drop_dead_klaviyo_idx.sql:
 *   - creates the partial index agent_jobs_queued_claim_idx (kind, claimed_at) WHERE status queued
 *   - drops the dead klaviyo_profile_staging_customer_idx
 *
 * Idempotent (create index if not exists / drop index if exists). Safe to re-run.
 * Also the ship-time apply so the before/after EXPLAIN can be measured immediately, rather than
 * waiting for control-tower's applyMergedMigrations on merge.
 */
import { pgClient } from "./_bootstrap";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const sql = readFileSync(
      resolve(__dirname, "../supabase/migrations/20261122120000_agent_jobs_queued_claim_idx_and_drop_dead_klaviyo_idx.sql"),
      "utf8",
    );
    await c.query(sql);
    console.log("✓ migration applied");

    const idx = await c.query(
      `select indexname from pg_indexes where schemaname='public' and tablename='agent_jobs'
         and indexname='agent_jobs_queued_claim_idx'`,
    );
    console.log("partial index present:", idx.rows.length === 1);

    const dead = await c.query(
      `select indexname from pg_indexes where schemaname='public' and indexname='klaviyo_profile_staging_customer_idx'`,
    );
    console.log("dead klaviyo index dropped:", dead.rows.length === 0);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
