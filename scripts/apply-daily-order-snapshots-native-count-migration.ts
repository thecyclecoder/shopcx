// apply-daily-order-snapshots-native-count-migration — add
// public.daily_order_snapshots.native_count and re-derive shopify_mismatch against
// SHOPIFY-ORIGIN orders only. Idempotent (ADD COLUMN IF NOT EXISTS + guarded UPDATE).
// Run against the pooler:
//   npx tsx scripts/apply-daily-order-snapshots-native-count-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261220120000_daily_order_snapshots_native_count.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: col } = await c.query(
      "select count(*)::int as n from information_schema.columns where table_name='daily_order_snapshots' and column_name='native_count'",
    );
    console.log(`✓ daily_order_snapshots.native_count present: ${col[0].n === 1}`);
    const { rows: st } = await c.query(
      `select count(*)::int total,
              count(*) filter (where shopify_mismatch)::int flagged,
              sum(native_count)::int native_total
       from public.daily_order_snapshots`,
    );
    console.log(`✓ ${st[0].total} snapshots · ${st[0].flagged} still flagged · ${st[0].native_total} ShopCX-native orders recorded`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
