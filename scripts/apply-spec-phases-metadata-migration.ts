// apply-spec-phases-metadata-migration — add public.spec_phases.metadata (jsonb).
// marco-logistics-director-seat Phase 1 — the durable per-phase decision surface Phase 1's landing
// decision (marco_landing = 'A' | 'B') lands on. Idempotent (ADD COLUMN IF NOT EXISTS + default '{}').
// Run against the pooler:
//   npx tsx scripts/apply-spec-phases-metadata-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261016120000_spec_phases_metadata.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.columns where table_name='spec_phases' and column_name='metadata'",
    );
    console.log(`✓ spec_phases.metadata column present: ${rows[0].n === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
