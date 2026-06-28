// apply-returns-internal-orders-migration — drop the NOT NULL on returns.shopify_order_gid so the
// internal-order return path can insert a Shopify-less return (label + Braintree refund).
//   npx tsx scripts/apply-returns-internal-orders-migration.ts
import { pgClient } from "./_bootstrap";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    await c.query(`alter table public.returns alter column shopify_order_gid drop not null`);
    const { rows } = await c.query(
      `select is_nullable from information_schema.columns
        where table_schema='public' and table_name='returns' and column_name='shopify_order_gid'`,
    );
    console.log("✓ returns.shopify_order_gid is_nullable:", rows[0]?.is_nullable);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
