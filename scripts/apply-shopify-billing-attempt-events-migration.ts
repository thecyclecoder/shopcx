// apply-shopify-billing-attempt-events-migration — create
// public.shopify_billing_attempt_events. Idempotent.
//   npx tsx scripts/apply-shopify-billing-attempt-events-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261224120000_shopify_billing_attempt_events.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const f of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", f), "utf8"));
      console.log(`✓ applied ${f}`);
    }
    const { rows } = await c.query(
      "select count(*)::int n from information_schema.columns where table_name='shopify_billing_attempt_events'");
    const { rows: rls } = await c.query(
      "select relrowsecurity from pg_class where relname='shopify_billing_attempt_events'");
    console.log(`✓ columns: ${rows[0].n} · RLS: ${rls[0]?.relrowsecurity}`);
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
