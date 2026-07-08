// apply-media-buyer-shadow-reviews-migration — create public.media_buyer_shadow_reviews
// (media-buyer-shadow-mode Phase 3). Idempotent (CREATE TABLE / TRIGGER / POLICY IF NOT EXISTS).
// Run against the pooler:
//   npx tsx scripts/apply-media-buyer-shadow-reviews-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260708023500_media_buyer_shadow_reviews.sql";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8"));
    console.log(`✓ applied ${MIGRATION}`);
    const { rows: t } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_schema='public' and table_name='media_buyer_shadow_reviews'",
    );
    console.log(`✓ media_buyer_shadow_reviews table present: ${t[0].n === 1}`);
    const { rows: cols } = await c.query(
      "select column_name from information_schema.columns where table_schema='public' and table_name='media_buyer_shadow_reviews' order by ordinal_position",
    );
    console.log(`✓ media_buyer_shadow_reviews columns: ${cols.map((r) => r.column_name).join(", ")}`);
    const { rows: idx } = await c.query(
      "select indexname from pg_indexes where schemaname='public' and tablename='media_buyer_shadow_reviews' order by indexname",
    );
    console.log(`✓ media_buyer_shadow_reviews indexes: ${idx.map((r) => r.indexname).join(", ")}`);
    const { rows: uniq } = await c.query(
      "select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid='public.media_buyer_shadow_reviews'::regclass and contype in ('u','p') order by conname",
    );
    console.log(`✓ unique/PK constraints: ${uniq.map((r) => `${r.conname} → ${r.def}`).join(" | ")}`);
    console.log("applied");
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
