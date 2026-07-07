// apply-create-compiled-trees-migration — create public.compiled_trees + its index
// (playbook-compiler-becomes-box-agent-mining-full-history Phase 1). The store the
// supervised playbook-compiler box agent (kind='playbook-compile') upserts recurring
// problem-to-resolution trees into via applyBoxPlaybookCompile
// ([[../src/lib/playbook-compiler.ts]]) — the substrate Phase 2 will read to propose
// data-grounded playbooks + playbook_steps (is_active=false). See
// docs/brain/tables/compiled_trees.md.
//
// Idempotent (CREATE TABLE / INDEX IF NOT EXISTS). Run against the pooler:
//   npx tsx scripts/apply-create-compiled-trees-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260924180000_create_compiled_trees.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: tableRows } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_schema='public' and table_name='compiled_trees'",
    );
    console.log(`✓ compiled_trees table present: ${tableRows[0].n === 1}`);
    const { rows: idxRows } = await c.query(
      "select indexname from pg_indexes where tablename='compiled_trees' order by indexname",
    );
    console.log(`✓ compiled_trees indexes: ${idxRows.map((r: { indexname: string }) => r.indexname).join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
