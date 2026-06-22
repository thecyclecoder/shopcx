// apply-workspaces-auto-fold-migration — add public.workspaces.auto_fold_enabled
// (auto-ship-pipeline Phase 2 / Gate B kill-switch). Idempotent (ADD COLUMN IF NOT EXISTS).
// Run against the pooler:
//   npx tsx scripts/apply-workspaces-auto-fold-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260622193000_workspaces_auto_fold.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.columns where table_name='workspaces' and column_name='auto_fold_enabled'",
    );
    console.log(`✓ workspaces.auto_fold_enabled column present: ${rows[0].n === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
