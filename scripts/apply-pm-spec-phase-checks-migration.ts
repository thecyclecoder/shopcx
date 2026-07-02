// apply-pm-spec-phase-checks-migration — create public.spec_phase_checks
// (pm-structured-intent-and-refs Phase 3). Idempotent.
// Run against the pooler:
//   npx tsx scripts/apply-pm-spec-phase-checks-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260807160000_pm_spec_phase_checks.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: t } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='spec_phase_checks'",
    );
    console.log(`✓ spec_phase_checks table present: ${t[0].n === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
