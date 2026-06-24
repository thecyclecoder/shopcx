// apply-director-coaching-migration — create director_coach_threads + director_instructions +
// director_coaching_log (worker-grading-and-director-management Phase 7): the CEO↔Director conversational
// coaching chat + the durable guidance store injected into her decisions, mirroring the worker-coaching
// loop one level up the org chart. Idempotent (CREATE … IF NOT EXISTS).
//   npx tsx scripts/apply-director-coaching-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260705140000_director_coaching.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select table_name from information_schema.tables where table_name in ('director_coach_threads', 'director_instructions', 'director_coaching_log') order by table_name",
    );
    console.log("✓ tables present:", rows.map((r) => r.table_name));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
