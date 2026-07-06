// apply-commerce-list-subscriptions-rpc-migration — install the
// `commerce_list_subscriptions` RPC (commerce-sdk-display-operations Phase 1).
// One round-trip projection of sub + latest_order + upcoming_order that
// `src/lib/commerce/subscription.ts` cursor-paginates over.
// Idempotent (CREATE OR REPLACE FUNCTION).
//   npx tsx scripts/apply-commerce-list-subscriptions-rpc-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260914120000_commerce_list_subscriptions_rpc.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select proname from pg_proc where proname = 'commerce_list_subscriptions'",
    );
    console.log("✓ function present:", rows.map((r) => r.proname));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
