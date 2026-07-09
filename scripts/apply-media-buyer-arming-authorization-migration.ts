// apply-media-buyer-arming-authorization-migration — create
// public.media_buyer_arming_authorization (media-buyer-arming-gate Phase 1).
// Per-(workspace, meta_ad_account, iso_week) authorization row that pins
// whether the Media Buyer cohort may move from mode='shadow' to mode='armed'.
// Idempotent (CREATE TABLE / TRIGGER / POLICY IF NOT EXISTS).
// Run against the pooler:
//   npx tsx scripts/apply-media-buyer-arming-authorization-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260708150000_media_buyer_arming_authorization.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: t } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='media_buyer_arming_authorization'",
    );
    console.log(`✓ media_buyer_arming_authorization table present: ${t[0].n === 1}`);
    const { rows: cols } = await c.query(
      "select column_name from information_schema.columns where table_name='media_buyer_arming_authorization' order by ordinal_position",
    );
    console.log(`✓ media_buyer_arming_authorization columns: ${cols.map((r) => r.column_name).join(", ")}`);
    const { rows: idx } = await c.query(
      "select indexname from pg_indexes where tablename='media_buyer_arming_authorization' order by indexname",
    );
    console.log(`✓ media_buyer_arming_authorization indexes: ${idx.map((r) => r.indexname).join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
