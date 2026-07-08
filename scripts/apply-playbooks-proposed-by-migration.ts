// apply-playbooks-proposed-by-migration — add playbooks.proposed_by +
// playbooks.source_tree_key + the partial UNIQUE / partial idx that anchor
// the compiler-seed-proposal flow (playbook-compiler-becomes-box-agent-
// mining-full-history Phase 2). Idempotent (ADD COLUMN / CREATE INDEX IF
// NOT EXISTS).
//
// Run against the pooler:
//   npx tsx scripts/apply-playbooks-proposed-by-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260924181000_playbooks_proposed_by.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: cols } = await c.query(
      "select column_name from information_schema.columns where table_name='playbooks' and column_name in ('proposed_by','source_tree_key') order by column_name",
    );
    console.log(`✓ playbooks columns present: ${cols.map((r: { column_name: string }) => r.column_name).join(", ")}`);
    const { rows: idxRows } = await c.query(
      "select indexname from pg_indexes where tablename='playbooks' and indexname in ('uidx_playbooks_source_tree_key','idx_playbooks_proposed') order by indexname",
    );
    console.log(`✓ playbooks indexes present: ${idxRows.map((r: { indexname: string }) => r.indexname).join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
