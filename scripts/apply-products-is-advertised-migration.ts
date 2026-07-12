// apply-products-is-advertised-migration — add the additive is_advertised boolean to public.products
// and seed the 6 named hero products (docs/brain/specs/hero-product-advertising-gate.md Phase 1).
//
// Idempotent — ADD COLUMN IF NOT EXISTS + UPDATE by title is safe to re-run.
//
//   npx tsx scripts/apply-products-is-advertised-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20261015000000_products_is_advertised.sql";

const HERO_TITLES = [
  "Superfood Tabs",
  "Amazing Coffee",
  "Amazing Creamer",
  "Ashwavana Guru Focus",
  "Ashwavana Zen Relax",
  "Creatine Prime+",
];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8"));
    console.log(`✓ applied ${MIGRATION}`);

    const { rows: cols } = await c.query(
      `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema='public' and table_name='products' and column_name='is_advertised'`,
    );
    console.log(`✓ products.is_advertised column:`, cols[0]);

    const { rows: hero } = await c.query(
      `select title, is_advertised
         from public.products
        where title = ANY($1)
        order by title`,
      [HERO_TITLES],
    );
    for (const r of hero) console.log(`  ${r.is_advertised ? "✓" : "✗"} ${r.title}`);

    const { rows: counts } = await c.query(
      `select
         count(*) filter (where is_advertised) as advertised,
         count(*) filter (where not is_advertised) as attachment
       from public.products`,
    );
    console.log(`✓ totals: ${counts[0].advertised} advertised · ${counts[0].attachment} attachment`);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
