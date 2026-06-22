// apply-storefront-optimizer-policy-migration — create the Storefront Optimizer
// activation + product-scope gate table (storefront-optimizer-activation-gate spec, Phase 1):
//   storefront_optimizer_policy — per-workspace on-switch + enforced product_scope +
//                                 auto_run_reversible opt-in + editable guardrails.
// Seeds the Superfoods workspace ON (propose-and-approve), scoped to Amazing Coffee.
// Idempotent (CREATE TABLE / INDEX / POLICY IF NOT EXISTS, ON CONFLICT DO NOTHING seed).
// Run against the pooler:
//   npx tsx scripts/apply-storefront-optimizer-policy-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260627120000_storefront_optimizer_policy.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: cols } = await c.query(
      "select count(*)::int as n from information_schema.columns where table_schema='public' and table_name=$1",
      ["storefront_optimizer_policy"],
    );
    console.log(`✓ public.storefront_optimizer_policy has ${cols[0].n} columns`);

    const { rows: seed } = await c.query(
      "select active, product_scope, auto_run_reversible from public.storefront_optimizer_policy where active = true",
    );
    if (seed.length) {
      const r = seed[0];
      console.log(
        `✓ seeded ${seed.length} active policy — active=${r.active}, product_scope=${JSON.stringify(r.product_scope)}, auto_run_reversible=${r.auto_run_reversible}`,
      );
    } else {
      console.log("⚠ no active policy seeded (Amazing Coffee product row not found?) — table default is active=false");
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
