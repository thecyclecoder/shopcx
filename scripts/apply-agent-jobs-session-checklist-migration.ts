// apply-agent-jobs-session-checklist-migration — add agent_jobs.session_checklist + session_note so
// the shared box-session streaming runner (scripts/builder-worker.ts → runBoxSession,
// box-session-transparency Phase 1) can stream the live TodoWrite checklist + current one-line note
// onto the running job's row. Additive + nullable. Idempotent.
//   npx tsx scripts/apply-agent-jobs-session-checklist-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260713120000_agent_jobs_session_checklist.sql";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8"));
    console.log(`✓ applied ${MIGRATION}`);
    const { rows } = await c.query(
      "select column_name from information_schema.columns where table_name='agent_jobs' and column_name in ('session_checklist','session_note') order by column_name",
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
