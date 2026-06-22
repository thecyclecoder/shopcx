// apply-spec-card-state-migration — create public.spec_card_state (spec-card-db-companion Phase 1:
// the live PM mirror the roadmap board reads DB-first). Idempotent (CREATE TABLE / INDEX IF NOT EXISTS).
// Run against the pooler:
//   npx tsx scripts/apply-spec-card-state-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260623130000_spec_card_state.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='spec_card_state'",
    );
    console.log(`✓ spec_card_state table present: ${rows[0].n === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
