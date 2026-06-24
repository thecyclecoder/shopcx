// apply-director-directives-migration — create public.director_directives (director-executable-plans-and-priority
// Phase 1 / the CEO's executable PLAN store: the one active directive a director runs first). Idempotent
// (CREATE TABLE / INDEX IF NOT EXISTS · DROP/CREATE POLICY). Run against the pooler:
//   npx tsx scripts/apply-director-directives-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260707120000_director_directives.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='director_directives'",
    );
    console.log(`✓ director_directives table present: ${rows[0].n === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
