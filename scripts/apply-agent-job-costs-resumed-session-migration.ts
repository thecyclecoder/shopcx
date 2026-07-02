// apply-agent-job-costs-resumed-session-migration — add `resumed_session boolean` + index to
// public.agent_job_costs (chained-phase-session-resume Phase 2). Idempotent (ADD COLUMN / CREATE INDEX
// IF NOT EXISTS). Run against the pooler:
//   npx tsx scripts/apply-agent-job-costs-resumed-session-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260702130000_agent_job_costs_resumed_session.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.columns where table_name='agent_job_costs' and column_name='resumed_session'",
    );
    console.log(`✓ agent_job_costs.resumed_session present: ${rows[0].n === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
