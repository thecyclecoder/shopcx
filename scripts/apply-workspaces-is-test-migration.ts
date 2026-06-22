// apply-workspaces-is-test-migration — add public.workspaces.is_test (spec-test-deep-verification Phase 2).
// Idempotent (ADD COLUMN / CREATE INDEX IF NOT EXISTS). Run against the pooler:
//   npx tsx scripts/apply-workspaces-is-test-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260622120000_workspaces_is_test.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.columns where table_name='workspaces' and column_name='is_test'",
    );
    console.log(`✓ workspaces.is_test column present: ${rows[0].n === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
