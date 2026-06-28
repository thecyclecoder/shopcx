// apply-specs-status-nullable-migration — make public.specs.status nullable + allow NULL in the CHECK
// (specs-status-override-only: a DERIVED status must be NULL; only true lifecycle overrides are stored).
// Idempotent. Run against the pooler:
//   npx tsx scripts/apply-specs-status-nullable-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260728140000_specs_status_nullable_derived.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select is_nullable from information_schema.columns where table_name='specs' and column_name='status'",
    );
    console.log(`✓ specs.status is_nullable=${rows[0].is_nullable}`);
    const { rows: cc } = await c.query(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname='specs_status_check'",
    );
    console.log(`✓ ${cc[0].def}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
