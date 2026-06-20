// apply-spec-test-human-checks-migration — create public.spec_test_human_checks (spec-test-agent Phase 2:
// the human-test queue's owner-resolution state). Idempotent (CREATE TABLE / INDEX / POLICY IF NOT EXISTS).
// Run against the pooler:
//   npx tsx scripts/apply-spec-test-human-checks-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260620130000_spec_test_human_checks.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='spec_test_human_checks'",
    );
    console.log(`✓ spec_test_human_checks table present: ${rows[0].n === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
