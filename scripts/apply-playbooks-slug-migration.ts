// apply-playbooks-slug-migration — Phase 1 of
// docs/brain/specs/sol-session-chosen-playbook-selection-retire-brittle-triggers.md.
// Adds `slug` to public.playbooks + a unique index (workspace_id, slug). Idempotent.
//
// Run against the pooler:
//   npx tsx scripts/apply-playbooks-slug-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260708120000_playbooks_slug.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: cols } = await c.query(
      `select column_name, is_nullable from information_schema.columns
       where table_schema='public' and table_name='playbooks' and column_name='slug'`,
    );
    console.log(`✓ playbooks.slug present: ${cols.length === 1}, nullable: ${cols[0]?.is_nullable ?? "n/a"}`);
    const { rows: idx } = await c.query(
      `select indexname from pg_indexes where schemaname='public' and tablename='playbooks' and indexname='playbooks_workspace_slug_key'`,
    );
    console.log(`✓ unique index playbooks_workspace_slug_key present: ${idx.length === 1}`);
    const { rows: sample } = await c.query(
      `select id, name, slug from public.playbooks order by created_at asc limit 5`,
    );
    console.log(`✓ backfill sample (${sample.length} rows):`);
    for (const r of sample) console.log(`  ${r.id.slice(0, 8)}  name="${r.name}"  slug="${r.slug}"`);
    const { rows: nullCount } = await c.query(
      `select count(*)::int as n from public.playbooks where slug is null`,
    );
    console.log(`✓ rows with null slug (must be 0): ${nullCount[0].n}`);
  } finally {
    await c.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
