// apply-agent-jobs-heartbeat-reaper-migration — add agent_jobs.last_heartbeat_at + reap_count so the
// shared box-session streaming runner (scripts/builder-worker.ts → runBoxSession) can bump a heartbeat
// while a session is alive and the in-loop stale-session reaper can re-queue a session that died mid-run
// (Max usage cap / crash / disconnect) instead of leaving a permanent `building` zombie holding the lane.
// Additive + nullable; reap_count defaults 0. Idempotent.
//   npx tsx scripts/apply-agent-jobs-heartbeat-reaper-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260802120000_agent_jobs_heartbeat_reaper.sql";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8"));
    console.log(`✓ applied ${MIGRATION}`);
    const { rows } = await c.query(
      "select column_name from information_schema.columns where table_name='agent_jobs' and column_name in ('last_heartbeat_at','reap_count') order by column_name",
    );
    console.log("✓ columns present:", rows.map((r) => r.column_name));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
