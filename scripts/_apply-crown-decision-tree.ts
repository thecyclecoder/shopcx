/**
 * Apply 20261018120000_crown_decision_tree_knobs.sql to the pooler + set the live policy values
 * (early_trim floor $200→$300; the 3 new knobs land at their column defaults 8 / $220 / $1,200).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { loadEnv, pgClient } from "./_bootstrap";
loadEnv();

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const sql = readFileSync(join(__dirname, "../supabase/migrations/20261018120000_crown_decision_tree_knobs.sql"), "utf8");
  const c = pgClient();
  await c.connect();
  try {
    await c.query(sql);
    console.log("✓ migration applied (columns + comments)");

    // Bump the fast-kill early-trim floor $200→$300 (2× CPA) on the active policy; new knobs already
    // defaulted to 8 / 22000 / 120000 by the migration. Report the resulting live row.
    await c.query(
      `update public.iteration_policies set early_trim_min_spend_cents = 30000, updated_at = now()
       where workspace_id = $1 and status = 'active'`,
      [WS],
    );
    const { rows } = await c.query(
      `select version, mode, crown_max_cpa_cents, crown_min_spend_cents, crown_min_purchases,
              hold_band_max_cpa_cents, max_test_spend_cents, early_trim_min_spend_cents
       from public.iteration_policies where workspace_id = $1 and status = 'active'`,
      [WS],
    );
    console.log("✓ live active policy now:");
    for (const r of rows) {
      console.log(`  crown ≤ $${r.crown_max_cpa_cents / 100} @ ≥ $${r.crown_min_spend_cents / 100} AND ≥ ${r.crown_min_purchases} purchases`);
      console.log(`  hold band ≤ $${r.hold_band_max_cpa_cents / 100} · deadline $${r.max_test_spend_cents / 100} · fast-kill floor $${r.early_trim_min_spend_cents / 100}`);
    }
  } finally {
    await c.end();
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
