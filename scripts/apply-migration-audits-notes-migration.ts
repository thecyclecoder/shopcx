// apply-migration-audits-notes-migration — add public.migration_audits.notes
// (migration-pin-and-item-robustness Phase 2). Idempotent (ADD COLUMN IF NOT
// EXISTS). Run against the pooler:
//   npx tsx scripts/apply-migration-audits-notes-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260623120000_migration_audits_notes.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.columns where table_name='migration_audits' and column_name='notes'",
    );
    console.log(`✓ migration_audits.notes column present: ${rows[0].n === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
