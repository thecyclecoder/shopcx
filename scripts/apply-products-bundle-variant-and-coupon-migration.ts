// apply-products-bundle-variant-and-coupon-migration — add bundle_variant_id
// and bundle_coupon_code columns to public.products for Phase 4 of
// offer-creator. Idempotent (IF NOT EXISTS + drop/add FK). Run against the
// pooler:
//   npx tsx scripts/apply-products-bundle-variant-and-coupon-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260926120000_products_bundle_variant_and_coupon.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: cols } = await c.query(
      `select column_name, data_type, is_nullable
         from information_schema.columns
        where table_name='products' and column_name in ('bundle_variant_id','bundle_coupon_code')
        order by column_name`,
    );
    const { rows: fks } = await c.query(
      `select conname
         from pg_constraint
        where conrelid = 'public.products'::regclass and conname = 'products_bundle_variant_id_fkey'`,
    );
    console.log(
      `✓ products.bundle_variant_id + bundle_coupon_code present: ${cols
        .map((r: { column_name: string; data_type: string; is_nullable: string }) => `${r.column_name}(${r.data_type}, nullable=${r.is_nullable})`)
        .join(", ")} | FK: ${fks.map((r: { conname: string }) => r.conname).join(", ") || "MISSING"}`,
    );
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
