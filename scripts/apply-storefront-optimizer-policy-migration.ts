// apply-storefront-optimizer-policy-migration — create the Storefront Optimizer
// activation + product-scope gate table (storefront-optimizer-activation-gate spec, Phase 1):
//   storefront_optimizer_policy — per-workspace on-switch + enforced product_scope +
//                                 auto_run_reversible opt-in + editable guardrails.
// Then seeds the Superfoods workspace ON (propose-and-approve), scoped to Amazing Coffee.
//
// Structure: the DDL (critical) is applied first; the data SEED is a SEPARATE guarded
// step so a seed hiccup never blocks the table. Idempotent throughout
// (CREATE … IF NOT EXISTS; the seed is `on conflict (workspace_id) do nothing`).
// On any failure we print the full Postgres error (code/detail/hint/position) so the
// offending statement is unambiguous. Run against the pooler:
//   npx tsx scripts/apply-storefront-optimizer-policy-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260627120000_storefront_optimizer_policy.sql";
const AMAZING_COFFEE_ID = "ea433e56-0aa4-4b46-9107-feb11f77f533";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    // ── 1. DDL (the critical part) ───────────────────────────────────────────
    await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8"));
    console.log(`✓ applied ${MIGRATION}`);

    const { rows: cols } = await c.query(
      "select count(*)::int as n from information_schema.columns where table_schema='public' and table_name=$1",
      ["storefront_optimizer_policy"],
    );
    console.log(`✓ public.storefront_optimizer_policy has ${cols[0].n} columns`);

    // ── 2. SEED — guarded + parameterized, isolated from the DDL ──────────────
    // Resolve the Superfoods workspace from the Amazing Coffee product row (no
    // hardcoded workspace id). Idempotent: skips if a policy already exists.
    const { rows: prod } = await c.query(
      "select workspace_id from public.products where id = $1",
      [AMAZING_COFFEE_ID],
    );
    if (!prod.length) {
      console.log(
        `⚠ Amazing Coffee product ${AMAZING_COFFEE_ID} not found — no seed written. ` +
          "Table default is active=false, so every workspace is safely OFF until a policy is set.",
      );
    } else {
      await c.query(
        `insert into public.storefront_optimizer_policy
           (workspace_id, active, product_scope, auto_run_reversible, created_by, rationale)
         values ($1, true, array[$2::uuid], false, 'human', $3)
         on conflict (workspace_id) do nothing`,
        [
          prod[0].workspace_id,
          AMAZING_COFFEE_ID,
          "Seed: optimizer ON in propose-and-approve mode, scoped to Amazing Coffee — proposes campaigns, owner taps Build to run each test.",
        ],
      );
      const { rows: seed } = await c.query(
        "select active, product_scope, auto_run_reversible from public.storefront_optimizer_policy where workspace_id = $1",
        [prod[0].workspace_id],
      );
      const r = seed[0];
      console.log(
        `✓ Superfoods policy — active=${r.active}, product_scope=${JSON.stringify(r.product_scope)}, auto_run_reversible=${r.auto_run_reversible}`,
      );
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  // Surface the full Postgres error so the offending statement is unambiguous.
  console.error("✗ apply failed:", e?.message ?? e);
  for (const k of ["code", "detail", "hint", "where", "position", "schema", "table", "constraint"] as const) {
    if (e?.[k]) console.error(`  ${k}: ${e[k]}`);
  }
  process.exit(1);
});
