// apply-agent-jobs-session-config-dir-migration — add public.agent_jobs.claude_session_config_dir
// (box-multi-account-failover Phase 1 — pin a session's resume to the Max account that created it).
// Idempotent (ADD COLUMN IF NOT EXISTS). Run against the pooler:
//   npx tsx scripts/apply-agent-jobs-session-config-dir-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260622210000_agent_jobs_session_config_dir.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.columns where table_name='agent_jobs' and column_name='claude_session_config_dir'",
    );
    console.log(`✓ agent_jobs.claude_session_config_dir column present: ${rows[0].n === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
