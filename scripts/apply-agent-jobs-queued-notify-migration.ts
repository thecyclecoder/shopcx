/**
 * Applies 20261201120000_agent_jobs_queued_notify.sql — the pg_notify('agent_job_queued') trigger that
 * makes box claims event-driven. Idempotent (create or replace fn + drop/create trigger). Safe to re-run.
 */
import { pgClient } from "./_bootstrap";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const sql = readFileSync(
      resolve(__dirname, "../supabase/migrations/20261201120000_agent_jobs_queued_notify.sql"),
      "utf8",
    );
    await c.query(sql);
    const trg = await c.query(
      `select tgname from pg_trigger where tgname='agent_job_queued_notify_trg' and not tgisinternal`,
    );
    console.log("✓ migration applied; trigger present:", trg.rows.length === 1);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
