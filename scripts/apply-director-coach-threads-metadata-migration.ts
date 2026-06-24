// apply-director-coach-threads-metadata-migration — add director_coach_threads.metadata jsonb so a
// chat-mode invitation thread (ada-slack-routed-approvals Phase 3) carries the routed approval's
// context (agent_job_id, notification_id, spec_slug). Additive + idempotent.
//   npx tsx scripts/apply-director-coach-threads-metadata-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260710120000_director_coach_threads_metadata.sql";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8"));
    console.log(`✓ applied ${MIGRATION}`);
    const { rows } = await c.query(
      "select column_name from information_schema.columns where table_name='director_coach_threads' and column_name='metadata'",
    );
    console.log("✓ metadata column present:", rows.map((r) => r.column_name));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
