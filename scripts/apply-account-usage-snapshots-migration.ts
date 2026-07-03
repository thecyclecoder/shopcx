// apply-account-usage-snapshots-migration — create public.account_usage_snapshots
// + public.usage_wall_events (Phase 1 of docs/brain/specs/fleet-usage-cockpit.md).
// Idempotent (CREATE TABLE / TRIGGER / POLICY IF NOT EXISTS).
//
// Run against the pooler:
//   npx tsx scripts/apply-account-usage-snapshots-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260814120000_account_usage_snapshots.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    for (const table of ["account_usage_snapshots", "usage_wall_events"]) {
      const { rows: t } = await c.query(
        `select count(*)::int as n from information_schema.tables where table_name=$1`,
        [table],
      );
      console.log(`✓ ${table} table present: ${t[0].n === 1}`);
      const { rows: cols } = await c.query(
        `select column_name from information_schema.columns where table_name=$1 order by ordinal_position`,
        [table],
      );
      console.log(`✓ ${table} columns: ${cols.map((r) => r.column_name).join(", ")}`);
      const { rows: uq } = await c.query(
        `select conname from pg_constraint where conrelid = ('public.' || $1)::regclass and contype = 'u'`,
        [table],
      );
      console.log(`✓ ${table} unique constraints: ${uq.map((r) => r.conname).join(", ")}`);
      const { rows: idx } = await c.query(
        `select indexname from pg_indexes where schemaname='public' and tablename=$1 order by indexname`,
        [table],
      );
      console.log(`✓ ${table} indexes: ${idx.map((r) => r.indexname).join(", ")}`);
      const { rows: pol } = await c.query(
        `select policyname from pg_policies where tablename=$1 order by policyname`,
        [table],
      );
      console.log(`✓ ${table} policies: ${pol.map((r) => r.policyname).join(", ")}`);
      const { rows: rls } = await c.query(
        `select relrowsecurity from pg_class where oid = ('public.' || $1)::regclass`,
        [table],
      );
      console.log(`✓ ${table} RLS enabled: ${rls[0].relrowsecurity === true}`);
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
