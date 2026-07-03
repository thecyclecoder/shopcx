// apply-pulse-session-digests-migration — create public.pulse_session_digests
// (founder-pulse Phase 1). Digest ledger the scripts/pulse-digest.ts local ingest
// upserts into, then the Phase-2 pulse.ts synthesizer joins against the specs
// ledger to write the five lenses. Idempotent (CREATE TABLE / TRIGGER / POLICY
// IF NOT EXISTS).
//
// Run against the pooler:
//   npx tsx scripts/apply-pulse-session-digests-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260812120000_pulse_session_digests.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: t } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='pulse_session_digests'",
    );
    console.log(`✓ pulse_session_digests table present: ${t[0].n === 1}`);
    const { rows: cols } = await c.query(
      "select column_name from information_schema.columns where table_name='pulse_session_digests' order by ordinal_position",
    );
    console.log(`✓ pulse_session_digests columns: ${cols.map((r) => r.column_name).join(", ")}`);
    const { rows: uq } = await c.query(
      `select conname from pg_constraint where conrelid = 'public.pulse_session_digests'::regclass and contype = 'u'`,
    );
    console.log(`✓ unique constraints: ${uq.map((r) => r.conname).join(", ")}`);
    const { rows: idx } = await c.query(
      `select indexname from pg_indexes where schemaname='public' and tablename='pulse_session_digests' order by indexname`,
    );
    console.log(`✓ indexes: ${idx.map((r) => r.indexname).join(", ")}`);
    const { rows: pol } = await c.query(
      `select policyname from pg_policies where tablename='pulse_session_digests' order by policyname`,
    );
    console.log(`✓ policies: ${pol.map((r) => r.policyname).join(", ")}`);
    const { rows: rls } = await c.query(
      `select relrowsecurity from pg_class where oid = 'public.pulse_session_digests'::regclass`,
    );
    console.log(`✓ RLS enabled: ${rls[0].relrowsecurity === true}`);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
