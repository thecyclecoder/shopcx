// apply-carrie-dr-content-migration — Phase 1 of docs/brain/specs/carrie-dr-content.md:
//   • grow product_media with category / source / caption + category CHECK + index
//   • create public.lander_content_gaps
// Idempotent (ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / DROP-then-ADD constraints).
//
// Run against the pooler:
//   npx tsx scripts/apply-carrie-dr-content-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260818120000_product_media_dr_columns_and_lander_content_gaps.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }

    // product_media new columns present.
    const { rows: pmCols } = await c.query(
      `select column_name from information_schema.columns
       where table_schema='public' and table_name='product_media'
         and column_name in ('category','source','caption')
       order by column_name`,
    );
    console.log(`✓ product_media columns present: ${pmCols.map((r) => r.column_name).join(", ")}`);

    // product_media CHECKs present.
    const { rows: pmChk } = await c.query(
      `select conname from pg_constraint
       where conrelid='public.product_media'::regclass and contype='c'
         and conname in ('product_media_category_check','product_media_source_check')
       order by conname`,
    );
    console.log(`✓ product_media CHECK constraints: ${pmChk.map((r) => r.conname).join(", ")}`);

    // product_media index present.
    const { rows: pmIdx } = await c.query(
      `select indexname from pg_indexes
       where schemaname='public' and tablename='product_media'
         and indexname='idx_product_media_product_category'`,
    );
    console.log(`✓ product_media category index present: ${pmIdx.length === 1}`);

    // lander_content_gaps table + columns + FKs + policies + RLS.
    const { rows: t } = await c.query(
      `select count(*)::int as n from information_schema.tables
       where table_schema='public' and table_name='lander_content_gaps'`,
    );
    console.log(`✓ lander_content_gaps table present: ${t[0].n === 1}`);

    const { rows: cols } = await c.query(
      `select column_name from information_schema.columns
       where table_schema='public' and table_name='lander_content_gaps'
       order by ordinal_position`,
    );
    console.log(`✓ lander_content_gaps columns: ${cols.map((r) => r.column_name).join(", ")}`);

    const { rows: fks } = await c.query(
      `select conname, pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid='public.lander_content_gaps'::regclass and contype='f'
       order by conname`,
    );
    for (const fk of fks) console.log(`✓ FK: ${fk.conname} — ${fk.def}`);

    const { rows: idx } = await c.query(
      `select indexname from pg_indexes
       where schemaname='public' and tablename='lander_content_gaps'
       order by indexname`,
    );
    console.log(`✓ lander_content_gaps indexes: ${idx.map((r) => r.indexname).join(", ")}`);

    const { rows: pol } = await c.query(
      `select policyname from pg_policies
       where tablename='lander_content_gaps' order by policyname`,
    );
    console.log(`✓ lander_content_gaps policies: ${pol.map((r) => r.policyname).join(", ")}`);

    const { rows: rls } = await c.query(
      `select relrowsecurity from pg_class where oid='public.lander_content_gaps'::regclass`,
    );
    console.log(`✓ lander_content_gaps RLS enabled: ${rls[0].relrowsecurity === true}`);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
