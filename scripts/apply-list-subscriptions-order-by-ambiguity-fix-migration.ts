// apply-list-subscriptions-order-by-ambiguity-fix-migration — recreate
// public.list_subscriptions so its paged-CTE ORDER BY qualifies the sort
// columns against the recovery_filtered alias (rf), removing the collision with
// the same-named RETURNS TABLE OUT parameters that raised
// 'column reference "next_billing_date" is ambiguous'.
//
// Phase 1 of the list-subscriptions-rpc-order-by-ambiguous-column-fix spec.
// Idempotent (DROP FUNCTION IF EXISTS + CREATE OR REPLACE). Run against the pooler:
//   npx tsx scripts/apply-list-subscriptions-order-by-ambiguity-fix-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261124120000_list_subscriptions_order_by_ambiguity_fix.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }

    // Verify the function exists with the expected signature.
    const { rows: fnRows } = await c.query(
      `select pg_get_function_identity_arguments(oid) as args
         from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname = 'list_subscriptions'`,
    );
    if (fnRows.length !== 1) throw new Error(`expected 1 list_subscriptions function, found ${fnRows.length}`);
    const argsSig = String(fnRows[0].args);
    console.log(`✓ function public.list_subscriptions(${argsSig})`);

    // Smoke-test the default sort path (random workspace uuid → no rows, but the
    // previous ambiguity error would raise here before returning).
    await c.query(
      `select * from public.list_subscriptions(
         $1::uuid, null, null, null, null, null, 'next_billing_date', 'asc', 20, 0)`,
      ["00000000-0000-0000-0000-000000000000"],
    );
    console.log("✓ default-sort call returned without ambiguity error");
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
